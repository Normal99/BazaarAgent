import type { Store } from "./store.ts"
import { PoliteClient } from "./http.ts"
import { sweepSearch } from "./finn/search.ts"
import { fetchFacets, findSeries, type SeriesFacet } from "./finn/facets.ts"

// Price discovery, which is a different job from deal hunting and needs its own
// queries.
//
// A saved search filtered to "under 120 000 kr" only ever returns the cheap end
// of the market. Valuing those cars against each other concludes that nothing
// is a bargain, because relative to the bargain bin nothing is. Measured on a
// real 180-listing corpus built purely from deal-hunting sweeps: every single
// valuation came out low-confidence, with residuals from +90% to -1969%.
//
// So for each model actually being watched, this sweeps finn *unfiltered* for
// that model to learn what it is worth across the whole price range.

export interface CorpusGap {
  readonly make: string
  readonly series: string | null
  readonly model: string | null
  /** Live listings currently held for this group. */
  readonly have: number
  readonly facet?: SeriesFacet
}

/** Model groups we hold too few comparables for to value anything confidently. */
export function findGaps(store: Store, facets: readonly SeriesFacet[], minComps = 25): CorpusGap[] {
  const rows = store.db
    .query<{ make: string; series: string | null; model: string | null; n: number }, []>(
      `SELECT make, series, model, COUNT(*) AS n FROM listings
       WHERE delisted_at IS NULL AND make IS NOT NULL
       GROUP BY make, COALESCE(series, model)
       ORDER BY n DESC`,
    )
    .all()

  const gaps: CorpusGap[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.n >= minComps) continue
    const facet = findSeries(facets, row.make, row.series, row.model)
    // Without a facet there is no query that would deepen this group, so
    // reporting it as a gap would just be noise.
    if (!facet || seen.has(facet.value)) continue
    seen.add(facet.value)
    gaps.push({ make: row.make, series: row.series, model: row.model, have: row.n, facet })
  }
  return gaps
}

export interface CorpusOptions {
  readonly store: Store
  readonly client?: PoliteClient
  /** Pages per model. 49 listings each. */
  readonly pagesPerModel?: number
  /** How many model groups to deepen in one run. */
  readonly maxModels?: number
  readonly minComps?: number
  readonly onProgress?: (line: string) => void
}

export async function buildCorpus(options: CorpusOptions): Promise<{ swept: number; models: number }> {
  const { store } = options
  const client = options.client ?? new PoliteClient()
  const log = options.onProgress ?? (() => {})
  const pages = options.pagesPerModel ?? 3
  const maxModels = options.maxModels ?? 8

  log("Fetching finn's make/model catalogue…")
  const facets = await fetchFacets(client)
  log(`  ${facets.length} series across ${new Set(facets.map((f) => f.make)).size} makes`)

  const gaps = findGaps(store, facets, options.minComps)
  log(`${gaps.length} model groups below the comparable threshold; deepening ${Math.min(gaps.length, maxModels)}`)

  let swept = 0
  let models = 0
  for (const gap of gaps.slice(0, maxModels)) {
    const facet = gap.facet!
    // Unfiltered on price deliberately: the whole range is the point.
    const url = new URL("https://www.finn.no/mobility/search/car")
    url.searchParams.set("variant", facet.value)
    url.searchParams.set("sort", "PUBLISHED_DESC")

    const entries = await sweepSearch(client, url, { maxPages: pages })
    const changes = store.ingest(entries)
    swept += entries.length
    models++
    log(`  ${facet.make} ${facet.series}: had ${gap.have}, fetched ${entries.length} (${changes.filter((c) => c.kind === "new").length} new, ${facet.hits} exist on finn)`)
  }

  return { swept, models }
}
