import { Store } from "./store.ts"
import { PoliteClient } from "./http.ts"
import { sweepSearch, normalizeSearchUrl, checkFilters } from "./finn/search.ts"
import { valueAll, enrichTop } from "./pipeline.ts"
import { buildCorpus } from "./corpus.ts"
import { reap } from "./reap.ts"
import { send, dealNotification } from "./notify/ntfy.ts"
import { acquire, held, type LockInfo } from "./lock.ts"

// Running the pipeline on demand, so the answer to "is there anything new?" is
// a button rather than a wait for the next quarter hour.
//
// One job at a time, and the lock is shared with the CLI the systemd timer
// runs — otherwise a manual sweep and a scheduled one hit finn simultaneously,
// each politely rate-limited and together twice as fast as intended.

export type JobName = "sweep" | "score" | "corpus" | "reap" | "notify"

export interface JobState {
  readonly name: JobName
  readonly startedAt: number
  readonly finishedAt?: number
  readonly status: "running" | "done" | "failed" | "blocked"
  readonly log: string[]
  readonly error?: string
  /** Who held the lock, when a job could not start. */
  readonly blockedBy?: LockInfo
}

let current: JobState | undefined
/** Kept so the UI can still show what happened after a job ends. */
let last: JobState | undefined

export const jobStatus = (): { current?: JobState; last?: JobState; lock?: LockInfo } => ({
  current,
  last,
  lock: held(),
})

const LABELS: Record<JobName, string> = {
  sweep: "Henter nye annonser",
  score: "Verdivurderer og rangerer",
  corpus: "Utvider sammenligningsgrunnlaget",
  reap: "Rydder solgte annonser",
  notify: "Sender varsler",
}

export interface StartOptions {
  readonly projects?: boolean
  readonly maxAnalyses?: number
  readonly noLlm?: boolean
}

/**
 * Begin a job, or say why not.
 *
 * Returns immediately: these take anywhere from twenty seconds to several
 * minutes, and a request that hangs for that long is worse than one that says
 * where to look for progress.
 */
export function startJob(name: JobName, options: StartOptions = {}): { started: boolean; state: JobState } {
  if (current?.status === "running") return { started: false, state: current }

  const attempt = acquire(name)
  if (!attempt.ok) {
    // The timer is mid-sweep. Saying so is more useful than queueing behind it
    // and appearing to hang.
    const blocked: JobState = {
      name,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: "blocked",
      log: [`Opptatt: «${attempt.held.task}» kjører allerede (pid ${attempt.held.pid}).`],
      blockedBy: attempt.held,
    }
    last = blocked
    return { started: false, state: blocked }
  }

  const log: string[] = [LABELS[name] + "…"]
  const state: JobState = { name, startedAt: Date.now(), status: "running", log }
  current = state

  const push = (line: string) => {
    log.push(line)
    // A job that logs without bound would eventually be the memory leak.
    if (log.length > 400) log.splice(0, log.length - 400)
  }

  void run(name, options, push)
    .then(() => {
      current = { ...state, status: "done", finishedAt: Date.now(), log }
    })
    .catch((error: unknown) => {
      current = {
        ...state,
        status: "failed",
        finishedAt: Date.now(),
        log,
        error: error instanceof Error ? error.message : String(error),
      }
    })
    .finally(() => {
      attempt.lock.release()
      last = current
      current = undefined
    })

  return { started: true, state }
}

async function run(name: JobName, options: StartOptions, log: (line: string) => void): Promise<void> {
  const store = new Store()
  const client = new PoliteClient()
  try {
    if (name === "sweep") {
      const searches = store.listSearches()
      if (searches.length === 0) {
        log("Ingen søk er satt opp.")
        return
      }
      for (const search of searches) {
        const url = normalizeSearchUrl(search.url)
        const first = await client.get(url.toString())
        const check = checkFilters(first.body, url)
        if (check.ignored.length > 0)
          log(`⚠ ${search.name}: finn ignorerer ${check.ignored.join(", ")} — søket henter ${check.matchCount.toLocaleString("nb-NO")} treff.`)

        const entries = await sweepSearch(client, url, { maxPages: 2 })
        const changes = store.ingest(entries, search.id)
        store.markSwept(search.id)
        const fresh = changes.filter((c) => c.kind === "new").length
        const moved = changes.filter((c) => c.kind === "price").length
        log(`${search.name}: ${entries.length} annonser · ${fresh} nye · ${moved} prisendringer`)
      }
      return
    }

    if (name === "score") {
      const budget = store.listSearches().find((s) => s.budget_nok)?.budget_nok ?? undefined
      const { valued, skipped, results } = valueAll({ store, budget: budget ?? undefined })
      log(`Verdivurderte ${valued} annonser (${skipped} uten nok sammenligningsgrunnlag).`)
      const enriched = await enrichTop(results, {
        store,
        client,
        budget: budget ?? undefined,
        projects: options.projects,
        noLlm: options.noLlm,
        maxAnalyses: options.maxAnalyses ?? 8,
        onProgress: log,
      })
      log(`Ferdig — ${enriched.length} gjennomgått.`)
      return
    }

    if (name === "corpus") {
      const result = await buildCorpus({ store, client, pagesPerModel: 3, maxModels: 2, onProgress: log })
      log(`Hentet ${result.swept} annonser for ${result.models} modellgrupper.`)
      return
    }

    if (name === "reap") {
      const result = await reap({ store, client, staleAfterHours: 24, max: 30, onProgress: log })
      log(`Sjekket ${result.checked}: ${result.delisted} borte, ${result.stillLive} fortsatt ute.`)
      return
    }

    if (name === "notify") {
      const searches = store.listSearches()
      const minScore = Math.min(...searches.map((s) => s.min_score), 6)
      const budget = searches.find((s) => s.budget_nok)?.budget_nok ?? undefined
      const pending = store.topDeals(60, minScore).filter((row) => !store.wasNotified(row.ad_id, "deal"))
      let sent = 0
      for (const row of pending.slice(0, 5)) {
        const listing = store.listing(row.ad_id)
        if (!listing) continue
        const ok = await send(
          dealNotification(
            { listing, valuation: { fairValue: row.fair_value ?? 0, residualPct: row.residual_pct ?? 0 } as any, score: row.score ?? 0, parts: [], registryFindings: [] },
            budget ?? undefined,
          ),
        )
        if (ok) {
          store.markNotified(row.ad_id, "deal")
          sent++
        }
      }
      log(sent > 0 ? `${sent} varsler sendt.` : "Ingen nye varsler å sende (eller ntfy er ikke satt opp).")
      return
    }
  } finally {
    store.close()
  }
}
