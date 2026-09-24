import { expect, test, describe, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "../src/paths.ts"
import { acquire, held } from "../src/lock.ts"

const LOCK = join(stateDir, "sweep.lock")
const clear = () => { try { if (existsSync(LOCK)) unlinkSync(LOCK) } catch {} }

beforeEach(() => { mkdirSync(stateDir, { recursive: true }); clear() })
afterEach(clear)

describe("one sweep at a time, across processes", () => {
  test("the first caller gets it, the second is told who has it", () => {
    // The reason this exists: PoliteClient rate-limits within a process, so
    // two processes each waiting politely still double what finn sees.
    const first = acquire("sweep")
    expect(first.ok).toBe(true)

    const second = acquire("corpus")
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.held.task).toBe("sweep")
    expect(second.held.pid).toBe(process.pid)
  })

  test("releasing hands it on", () => {
    const first = acquire("sweep")
    if (!first.ok) throw new Error("expected the lock")
    first.lock.release()

    expect(held()).toBeUndefined()
    expect(acquire("score").ok).toBe(true)
  })

  test("releasing twice is harmless", () => {
    const first = acquire("sweep")
    if (!first.ok) throw new Error("expected the lock")
    first.lock.release()
    first.lock.release()
    expect(held()).toBeUndefined()
  })

  test("a lock held by a dead process is taken over", () => {
    // Otherwise a crashed sweep stops the agent working until a human notices
    // a file they have never heard of.
    writeFileSync(LOCK, JSON.stringify({ pid: 0x7ffffff0, task: "sweep", since: Date.now() }))
    expect(held()).toBeUndefined()
    expect(acquire("sweep").ok).toBe(true)
  })

  test("a lock held far too long is taken over even if the pid is alive", () => {
    // A hung process must not hold it forever.
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, task: "sweep", since: Date.now() - 60 * 60_000 }))
    expect(held()).toBeUndefined()
    expect(acquire("sweep").ok).toBe(true)
  })

  test("a fresh lock from a live process is respected", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, task: "corpus", since: Date.now() }))
    expect(held()?.task).toBe("corpus")
    expect(acquire("sweep").ok).toBe(false)
  })

  test("an unreadable lock file does not wedge the agent", () => {
    writeFileSync(LOCK, "{ not json")
    expect(held()).toBeUndefined()
    expect(acquire("sweep").ok).toBe(true)
  })

  test("releasing does not delete a lock someone else took over", () => {
    const first = acquire("sweep")
    if (!first.ok) throw new Error("expected the lock")
    // Another process takes over after ours went stale.
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid + 1, task: "corpus", since: Date.now() }))
    first.lock.release()
    expect(existsSync(LOCK)).toBe(true)
  })
})
