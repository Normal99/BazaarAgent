import type { Store } from "./store.ts"
import { PoliteClient, FetchError } from "./http.ts"

// Retiring listings that have sold.
//
// This matters more than it sounds. Every sold car we keep is a car that did
// not sell at its asking price still counted as evidence of market value, and
// what lingers is disproportionately the overpriced end. Left alone the
// corpus drifts upward and, eventually, everything looks like a bargain.
//
// Absence from a sweep cannot be used to infer it. Sweeps read the first page
// or two, so a live listing on page five goes stale without being gone — which
// is why this verifies over HTTP rather than reasoning about what it did not
// see. finn answers 404 for an ad that no longer exists; a live one answers
// 200. "Ikke lenger tilgjengelig" is not usable as a marker, since that phrase
// appears in boilerplate on live pages too.

export interface ReapOptions {
  readonly store: Store
  readonly client?: PoliteClient
  /** Only check listings unseen for at least this long. */
  readonly staleAfterHours?: number
  /** Cap per run, so a backlog does not turn into a thousand requests. */
  readonly max?: number
  readonly onProgress?: (line: string) => void
}

export interface ReapResult {
  readonly checked: number
  readonly delisted: number
  readonly stillLive: number
}

export async function reap(options: ReapOptions): Promise<ReapResult> {
  const { store } = options
  const client = options.client ?? new PoliteClient()
  const log = options.onProgress ?? (() => {})
  const staleAfter = (options.staleAfterHours ?? 24) * 3_600_000
  const max = options.max ?? 40

  const candidates = store.db
    .query<{ ad_id: number; url: string; heading: string; last_seen: number }, [number, number]>(
      `SELECT ad_id, url, heading, last_seen FROM listings
       WHERE delisted_at IS NULL AND last_seen < ?
       ORDER BY last_seen ASC LIMIT ?`,
    )
    .all(Date.now() - staleAfter, max)

  log(`${candidates.length} listings unseen for ${options.staleAfterHours ?? 24}h — verifying`)

  let delisted = 0
  let stillLive = 0
  const markGone = store.db.query("UPDATE listings SET delisted_at = ? WHERE ad_id = ? AND delisted_at IS NULL")
  const markSeen = store.db.query("UPDATE listings SET last_seen = ? WHERE ad_id = ?")

  for (const candidate of candidates) {
    try {
      await client.get(candidate.url)
      // Still there: record that we looked, so it is not re-checked tomorrow.
      markSeen.run(Date.now(), candidate.ad_id)
      stillLive++
    } catch (error) {
      if (error instanceof FetchError && error.status === 404) {
        markGone.run(Date.now(), candidate.ad_id)
        delisted++
        log(`  gone: ${candidate.heading} (${candidate.ad_id})`)
      } else {
        // A timeout or a 500 says nothing about whether the car sold. Leave it
        // alone and try again next run rather than retiring a live listing.
        log(`  ${candidate.ad_id}: check failed, leaving as live — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return { checked: candidates.length, delisted, stillLive }
}
