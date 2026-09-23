import { extractSearchState } from "./search.ts"
import type { PoliteClient } from "../http.ts"

// finn's search page ships its own facet tree, and the "variant" filter is the
// make/model catalogue: every make with an id, every series beneath it with an
// id and a live hit count. That catalogue is what makes targeted price
// discovery possible — without it there is no way to ask finn for "every
// Golf-Serie" rather than "whatever happens to be newest".
//
// The series names here match the `series` field on listings exactly
// ("Golf-Serie", "Passat-Serie"), which is what lets a thin comp set be
// mapped back to the query that would deepen it.

export interface SeriesFacet {
  readonly make: string
  readonly series: string
  /** finn filter value, e.g. "1.817.1590". Goes in `?variant=`. */
  readonly value: string
  /** How many live listings finn has for it. */
  readonly hits: number
}

export interface FacetCatalogue {
  readonly fetchedAt: number
  readonly series: SeriesFacet[]
}

export function parseVariantFacets(html: string): SeriesFacet[] {
  const data = extractSearchState(html) as { filters?: Array<Record<string, any>> }
  const variant = (data.filters ?? []).find((f) => f.name === "variant")
  if (!variant) return []

  const out: SeriesFacet[] = []
  for (const make of variant.filter_items ?? []) {
    const makeName = String(make.display_name ?? "")
    for (const series of make.filter_items ?? []) {
      if (typeof series.value !== "string") continue
      out.push({
        make: makeName,
        series: String(series.display_name ?? ""),
        value: series.value,
        hits: Number(series.hits) || 0,
      })
    }
  }
  return out
}

/** Fetch the catalogue. One request covers every make and series finn lists. */
export async function fetchFacets(client: PoliteClient): Promise<SeriesFacet[]> {
  const response = await client.get("https://www.finn.no/mobility/search/car")
  return parseVariantFacets(response.body)
}

/**
 * Find the query that would deepen a given series.
 *
 * finn's display names carry the "-Serie" suffix that listings use, but a
 * listing's `series` is occasionally null (Amarok, ID.3, Multivan), in which
 * case the model name is the only handle and a looser match is the best
 * available.
 */
export function findSeries(facets: readonly SeriesFacet[], make: string, series: string | null, model: string | null): SeriesFacet | undefined {
  const wantedMake = make.toLowerCase()
  const candidates = facets.filter((f) => f.make.toLowerCase() === wantedMake)
  if (candidates.length === 0) return undefined

  if (series) {
    const exact = candidates.find((f) => f.series.toLowerCase() === series.toLowerCase())
    if (exact) return exact
  }
  if (model) {
    const byModel = candidates.find((f) => f.series.toLowerCase() === `${model.toLowerCase()}-serie` || f.series.toLowerCase() === model.toLowerCase())
    if (byModel) return byModel
  }
  return undefined
}
