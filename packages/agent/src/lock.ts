import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "./paths.ts"

// One sweep at a time, across processes.
//
// PoliteClient rate-limits within a process. That is enough while the systemd
// timer is the only thing sweeping, and stops being enough the moment the web
// UI can start one too: two processes each politely waiting two seconds
// between requests still doubles what finn sees. The politeness rules are a
// property of the system, not of one object.
//
// A file with a pid in it, rather than a real advisory lock, because the two
// participants are a systemd oneshot and a long-lived server on the same
// machine — and a stale lock from a killed process has to be recoverable
// without the user learning what a lock file is.

const LOCK_PATH = () => join(stateDir, "sweep.lock")

/** Long enough for a slow sweep, short enough that a crash is not permanent. */
const STALE_AFTER_MS = 25 * 60_000

export interface LockInfo {
  readonly pid: number
  readonly task: string
  readonly since: number
}

function read(): LockInfo | undefined {
  try {
    if (!existsSync(LOCK_PATH())) return undefined
    const raw = JSON.parse(readFileSync(LOCK_PATH(), "utf8")) as Partial<LockInfo>
    if (typeof raw.pid !== "number") return undefined
    return { pid: raw.pid, task: String(raw.task ?? "?"), since: Number(raw.since) || 0 }
  } catch {
    return undefined
  }
}

/** Whether a process is still alive. Signal 0 tests without actually signalling. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface HeldLock {
  readonly task: string
  release(): void
}

/**
 * Take the lock, or report who holds it.
 *
 * A lock whose owner has died, or which has simply been held too long, is
 * taken over: a crashed sweep must not stop the agent working until someone
 * notices and deletes a file.
 */
export function acquire(task: string): { ok: true; lock: HeldLock } | { ok: false; held: LockInfo } {
  const existing = read()
  if (existing) {
    const stale = !alive(existing.pid) || Date.now() - existing.since > STALE_AFTER_MS
    if (!stale) return { ok: false, held: existing }
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(LOCK_PATH(), JSON.stringify({ pid: process.pid, task, since: Date.now() }), { mode: 0o600 })

  let released = false
  return {
    ok: true,
    lock: {
      task,
      release() {
        if (released) return
        released = true
        try {
          // Only remove our own: a takeover may have happened underneath us.
          const current = read()
          if (current?.pid === process.pid) unlinkSync(LOCK_PATH())
        } catch {
          // A lock we cannot remove goes stale on its own.
        }
      },
    },
  }
}

/** Who holds the lock right now, if anyone. */
export function held(): LockInfo | undefined {
  const existing = read()
  if (!existing) return undefined
  if (!alive(existing.pid) || Date.now() - existing.since > STALE_AFTER_MS) return undefined
  return existing
}

/** Run something under the lock, releasing it whatever happens. */
export async function withLock<T>(task: string, fn: () => Promise<T>): Promise<T | { skipped: LockInfo }> {
  const result = acquire(task)
  if (!result.ok) return { skipped: result.held }
  try {
    return await fn()
  } finally {
    result.lock.release()
  }
}
