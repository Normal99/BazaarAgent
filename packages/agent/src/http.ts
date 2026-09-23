// Every request to finn.no goes through here, so the politeness rules are
// enforced in one place rather than trusted to each call site.
//
// finn.no publishes no API and their robots.txt is self-contradictory: it opens
// with a blanket "crawling is prohibited" and then explicitly allows
// /mobility/item and /mobility/search. This resolves that in favour of traffic a
// human could plausibly generate — serial, slow, cached, and confined to the
// allowed paths — and makes it impossible to accidentally do otherwise.

export class FetchError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message)
    this.name = "FetchError"
  }
}

export interface PoliteOptions {
  /** Minimum gap between requests. */
  readonly minIntervalMs?: number
  readonly userAgent?: string
  readonly maxRetries?: number
  /** Paths that may be requested at all, matched as prefixes. */
  readonly allowPaths?: readonly string[]
}

const DEFAULTS = {
  minIntervalMs: 2_000,
  // Honest about what this is and who to contact — an anonymous browser UA
  // would be pretending to be something it isn't.
  userAgent: "BazaarAgent/0.1 (personal listing watcher; +https://github.com/Normal99/BazaarAgent)",
  maxRetries: 3,
  allowPaths: ["/mobility/item", "/mobility/search"],
} as const

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface CachedResponse {
  readonly body: string
  readonly etag?: string
  readonly lastModified?: string
  /** True when the server answered 304 and the caller's cached copy still stands. */
  readonly notModified: boolean
}

export class PoliteClient {
  private readonly options: Required<PoliteOptions>
  /** Serialises every request; concurrency is the thing most likely to look abusive. */
  private queue: Promise<unknown> = Promise.resolve()
  private lastRequestAt = 0
  /** Set when the server pushes back; all requests wait until it passes. */
  private backoffUntil = 0

  constructor(options: PoliteOptions = {}) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Fetch a URL as text, respecting the rate limit, the allow-list and any active backoff. */
  async get(url: string, conditional: { etag?: string; lastModified?: string } = {}): Promise<CachedResponse> {
    const path = new URL(url).pathname
    if (!this.options.allowPaths.some((allowed) => path.startsWith(allowed)))
      throw new FetchError(0, url, `Refusing to request ${path} — only ${this.options.allowPaths.join(", ")} are allowed.`)

    const run = async (): Promise<CachedResponse> => {
      for (let attempt = 1; ; attempt++) {
        const waitFor = Math.max(this.backoffUntil - Date.now(), this.lastRequestAt + this.options.minIntervalMs - Date.now(), 0)
        if (waitFor > 0) await sleep(waitFor)
        this.lastRequestAt = Date.now()

        const headers: Record<string, string> = {
          "user-agent": this.options.userAgent,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7",
        }
        if (conditional.etag) headers["if-none-match"] = conditional.etag
        if (conditional.lastModified) headers["if-modified-since"] = conditional.lastModified

        const response = await fetch(url, { headers, redirect: "follow" }).catch((error: unknown) => {
          throw new FetchError(0, url, `Network error: ${error instanceof Error ? error.message : String(error)}`)
        })

        if (response.status === 304) return { body: "", notModified: true }

        // Back off hard and for a long time when told to. Retrying briskly
        // against a 429 is exactly the behaviour that gets an IP blocked.
        if (response.status === 429 || response.status === 403 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"))
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000)
          this.backoffUntil = Date.now() + delay
          if (attempt >= this.options.maxRetries)
            throw new FetchError(response.status, url, `${url} returned ${response.status} after ${attempt} attempts; backing off.`)
          continue
        }

        if (!response.ok) throw new FetchError(response.status, url, `${url} returned ${response.status} ${response.statusText}.`)

        return {
          body: await response.text(),
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined,
          notModified: false,
        }
      }
    }

    const result = this.queue.then(run, run)
    // Keep the chain alive even when a request throws, or one failure would
    // wedge every later request behind a rejected promise.
    this.queue = result.catch(() => undefined)
    return result
  }
}
