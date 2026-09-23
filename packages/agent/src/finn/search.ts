import { SearchDataSchema, type SearchEntry, type SearchPage } from "./types.ts"
import type { PoliteClient } from "../http.ts"

// finn's search results arrive inside the server-rendered page, not from a JSON
// API. `/mobility/search/api` exists but rejects the query shapes the page
// itself appears to use, so the reliable source is the React Query cache the
// page ships to hydrate itself: a <script type="application/json"
// data-react-query-state> element whose contents are base64-encoded JSON.
//
// That blob holds several queries keyed by "scope". The one worth reading is
// scope "search" — 49 listings per page with full structured fields. ("poleposition"
// is the promoted slot: one paid listing, which should not be treated as a find.)

const STATE_RE = /<script type="application\/json" data-react-query-state>([\s\S]*?)<\/script>/

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ParseError"
  }
}

/** Decode the hydration blob and return the "search" query's data, unvalidated. */
export function extractSearchState(html: string): unknown {
  const match = STATE_RE.exec(html)
  if (!match) throw new ParseError("No data-react-query-state script found — finn's page structure has changed.")

  let decoded: string
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8")
  } catch {
    throw new ParseError("data-react-query-state was not valid base64.")
  }

  let state: unknown
  try {
    state = JSON.parse(decoded)
  } catch {
    throw new ParseError("data-react-query-state did not decode to JSON.")
  }

  const queries = (state as { queries?: unknown }).queries
  if (!Array.isArray(queries)) throw new ParseError("Hydration state had no queries array.")

  const search = queries.find((query: unknown) => {
    const key = (query as { queryKey?: unknown[] })?.queryKey?.[0] as { scope?: string } | undefined
    return key?.scope === "search"
  })
  if (!search) throw new ParseError(`No query with scope "search" (found: ${queries.map((q: any) => q?.queryKey?.[0]?.scope).join(", ")}).`)

  return (search as { state?: { data?: unknown } }).state?.data
}

/** Parse one search results page. Throws ParseError if the shape finn returns has drifted. */
export function parseSearchPage(html: string): SearchPage {
  const data = extractSearchState(html)
  const parsed = SearchDataSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")
    throw new ParseError(`finn's search payload no longer matches the expected shape — ${issues}`)
  }

  const { docs, metadata } = parsed.data
  return {
    entries: docs,
    page: metadata?.paging?.current ?? 1,
    lastPage: metadata?.paging?.last ?? 1,
    matchCount: metadata?.result_size?.match_count ?? docs.length,
    title: metadata?.title,
  }
}

/**
 * Normalise whatever the user pasted into a search URL we can page through.
 *
 * finn saved searches live behind a login, but the *filters* are all in the URL
 * of the results page, so pasting that URL is enough and avoids needing the
 * user's session cookie.
 */
export function normalizeSearchUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ParseError(`"${raw}" is not a URL. Open your saved search on finn.no and copy the address bar.`)
  }
  if (!url.hostname.endsWith("finn.no")) throw new ParseError(`${url.hostname} is not finn.no.`)
  if (!url.pathname.startsWith("/mobility/search"))
    throw new ParseError(`Only /mobility/search URLs are supported for now, not ${url.pathname}.`)
  // Paging is ours to control.
  url.searchParams.delete("page")
  return url
}

export interface SweepOptions {
  /** Hard ceiling on pages. finn caps at 50; the default keeps a routine poll cheap. */
  readonly maxPages?: number
  readonly onPage?: (page: SearchPage) => void
}

/**
 * Walk a search from page 1, newest first, yielding every listing found.
 *
 * Deal-hunting only needs the first page or two — anything older has already
 * been seen. Building the comparables corpus wants many more, which is why
 * maxPages is a parameter rather than a constant.
 */
export async function sweepSearch(client: PoliteClient, searchUrl: URL, options: SweepOptions = {}): Promise<SearchEntry[]> {
  const maxPages = Math.min(options.maxPages ?? 2, 50)
  const entries: SearchEntry[] = []
  const seen = new Set<number>()

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(searchUrl)
    if (page > 1) url.searchParams.set("page", String(page))

    const response = await client.get(url.toString())
    if (response.notModified) break

    const parsed = parseSearchPage(response.body)
    options.onPage?.(parsed)

    for (const entry of parsed.entries) {
      // finn repeats promoted listings across pages; count each car once.
      if (seen.has(entry.ad_id)) continue
      seen.add(entry.ad_id)
      entries.push(entry)
    }

    if (page >= parsed.lastPage) break
  }

  return entries
}
