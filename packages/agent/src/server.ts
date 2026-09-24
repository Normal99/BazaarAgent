import { join } from "node:path"
import { Store } from "./store.ts"
import { selectComps, fitPriceModel, type ValuationTarget } from "./value/comps.ts"
import { buildHagglePlan } from "./value/haggle.ts"
import { normalizeSearchUrl } from "./finn/search.ts"
import { parseSearchRequirements } from "./store.ts"
import { parseRequirements, summarise, type RequirementMatch } from "./value/requirements.ts"
import { euControlFor } from "./pipeline.ts"
import { travelCost } from "./value/distance.ts"
import { loadHome, setDistanceScoring } from "./home.ts"
import { startJob, jobStatus, type JobName } from "./jobs.ts"
import { stripUnreliableOdometerClaims } from "./value/score.ts"

// A small JSON API plus the static PWA. One server, reached from a phone over
// Tailscale and from a browser on the same machine, so there is one UI codebase
// rather than a desktop one and a mobile one.

const UI_DIR = join(import.meta.dir, "..", "ui")

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })

export interface ServerOptions {
  readonly port?: number
  /** 0.0.0.0 so a phone on the tailnet can reach it; loopback keeps it local. */
  readonly hostname?: string
  readonly store?: Store
}

export function startServer(options: ServerOptions = {}) {
  const store = options.store ?? new Store()
  const port = options.port ?? 3000
  const hostname = options.hostname ?? "0.0.0.0"

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 60,

    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname

      try {
        if (path === "/api/deals") return json(deals(store, url))
        if (path.startsWith("/api/deal/")) return dealDetail(store, Number(path.slice("/api/deal/".length)))
        if (path === "/api/searches")
          return request.method === "POST"
            ? await addSearch(store, request)
            : json(
                store.listSearches(false).map((row) => ({
                  ...row,
                  requirements: parseSearchRequirements(row),
                  active: (store.db.query("SELECT active FROM searches WHERE id = ?").get(row.id) as any)?.active === 1,
                })),
              )
        if (path.startsWith("/api/searches/")) {
          const id = Number(path.slice("/api/searches/".length).split("/")[0])
          if (!Number.isFinite(id)) return json({ error: "bad id" }, 400)
          if (request.method === "DELETE") return json({ deleted: store.deleteSearch(id) })
          if (request.method === "POST") {
            const body = (await request.json()) as { active?: boolean }
            return json({ updated: store.setSearchActive(id, body.active !== false) })
          }
          return json({ error: "method not allowed" }, 405)
        }
        if (path === "/api/health") return json(health(store))
        if (path === "/api/jobs") return json(jobStatus())
        if (path.startsWith("/api/jobs/")) {
          if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
          const name = path.slice("/api/jobs/".length) as JobName
          if (!["sweep", "score", "corpus", "reap", "notify"].includes(name)) return json({ error: `unknown job ${name}` }, 400)
          const body = (await request.json().catch(() => ({}))) as { projects?: boolean; noLlm?: boolean; maxAnalyses?: number }
          return json(startJob(name, body))
        }
        if (path === "/api/home") {
          if (request.method !== "POST") return json(loadHome() ?? null)
          const body = (await request.json()) as { scoreDistance?: boolean; weight?: number }
          return json(setDistanceScoring(body))
        }
        if (path.startsWith("/api/watch/")) return toggleWatch(store, Number(path.slice("/api/watch/".length)))

        // Static UI. Unknown paths fall back to the shell so client routing works.
        //
        // `no-cache` means revalidate, not "never cache": the browser keeps the
        // file but asks whether it changed. Without it a phone happily serves a
        // months-old app.js after an update, which during development looked
        // exactly like a rendering bug.
        const headers = { "cache-control": "no-cache" }
        const file = Bun.file(join(UI_DIR, path === "/" ? "index.html" : path.replace(/^\/+/, "")))
        if (await file.exists()) return new Response(file, { headers })
        return new Response(Bun.file(join(UI_DIR, "index.html")), { headers })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  })

  return { server, store, url: `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}` }
}

// ---------------------------------------------------------------------------

function deals(store: Store, url: URL) {
  const min = Number(url.searchParams.get("min") ?? 0)
  const limit = Number(url.searchParams.get("limit") ?? 50)
  const budget = store.listSearches().find((s) => s.budget_nok)?.budget_nok ?? undefined
  const home = loadHome()
  // Looked up in bulk rather than per row: a feed of 200 would otherwise be
  // 400 extra queries.
  const watched = store.watchedAdIds()
  const relisted = store.relistedAdIds()
  const bySearch = store.searchIdsByListing()

  return {
    budget,
    home: home ? { label: home.label, scoreDistance: home.scoreDistance, weight: home.weight } : null,
    // So the feed can be narrowed to one hunt without a second round trip.
    searches: store.listSearches(false).map((row) => ({ id: row.id, name: row.name })),
    deals: store.topDeals(limit, min).map((row) => {
      const model = row.model_json ? JSON.parse(row.model_json) : {}
      const levers: Array<{ estValueNok: number }> = row.levers_json ? JSON.parse(row.levers_json) : []
      const leverTotal = levers.reduce((sum, l) => sum + (l.estValueNok || 0), 0)
      const listing = store.listing(row.ad_id)
      const images: string[] = listing?.image_urls ? JSON.parse(listing.image_urls) : []

      // The headline case: over budget on the sticker, reachable by negotiating.
      const defensible = (row.fair_value ?? row.price) - Math.min(leverTotal, (row.fair_value ?? row.price) * 0.1)
      const haggleable = budget !== undefined && row.price > budget && defensible <= budget

      return {
        adId: row.ad_id,
        heading: row.heading,
        url: row.url,
        year: row.year,
        mileage: row.mileage,
        price: row.price,
        dealerSegment: row.dealer_segment,
        location: row.location,
        fairValue: row.fair_value,
        residualPct: row.residual_pct,
        compCount: row.comp_count,
        score: row.score,
        confidence: model.confidence ?? null,
        listingType: row.listing_type,
        condition: row.condition ?? "running",
        project: row.project_json ? JSON.parse(row.project_json) : null,
        // The score breakdown was computed and stored from the start and never
        // shown. A ranking you cannot interrogate is one you end up ignoring.
        parts: model.parts ?? [],
        watched: watched.has(row.ad_id),
        relisted: relisted.has(row.ad_id),
        searchIds: bySearch.get(row.ad_id) ?? [],
        make: listing?.make ?? null,
        fuel: listing?.fuel ?? null,
        transmission: listing?.transmission ?? null,
        publishedAt: listing?.published_at ?? null,
        requirements: (model.requirements ?? []) as RequirementMatch[],
        missingRequired: ((model.requirements ?? []) as RequirementMatch[]).filter((r) => r.required && r.status === "nei").length,
        disqualified: model.disqualified ?? null,
        summary: row.summary,
        leverTotal,
        haggleable,
        overBudgetBy: budget !== undefined && row.price > budget ? row.price - budget : null,
        trip:
          home && listing?.lat != null && listing?.lon != null
            ? (() => {
                const t = travelCost(home, { lat: listing.lat!, lon: listing.lon! })
                return { roadKm: Math.round(t.roadKm), costNok: Math.round(t.costNok), hours: t.hours }
              })()
            : null,
        thumb: images[0] ?? null,
      }
    }),
  }
}

function dealDetail(store: Store, adId: number): Response {
  const listing = store.listing(adId)
  if (!listing) return json({ error: "not found" }, 404)

  const row = store.db.query("SELECT * FROM valuations WHERE ad_id = ?").get(adId) as any
  const analysisRow = store.db.query("SELECT * FROM analyses WHERE ad_id = ?").get(adId) as any
  const specs = store.specs(adId)
  const model = row?.model_json ? JSON.parse(row.model_json) : {}

  const target: ValuationTarget = {
    adId,
    make: listing.make ?? "",
    model: listing.model,
    series: listing.series,
    year: listing.year,
    mileage: listing.mileage,
    fuel: listing.fuel,
    transmission: listing.transmission,
  }
  const selection = selectComps(store, target)
  const priceModel = selection ? fitPriceModel(selection.comps) : undefined

  // The curve the estimate came from, sampled so the chart can draw the trend
  // this car is being judged against rather than just asserting a number.
  const year = new Date().getFullYear()
  const trend: Array<{ km: number; price: number }> = []
  if (priceModel && selection) {
    const kms = selection.comps.map((c) => c.mileage)
    const lo = Math.min(...kms, listing.mileage)
    const hi = Math.max(...kms, listing.mileage)
    for (let i = 0; i <= 20; i++) {
      const km = lo + ((hi - lo) * i) / 20
      trend.push({ km, price: priceModel.predict(year - listing.year, km) })
    }
  }

  // Same gate as the pipeline: a claim resting on an unreliable photo odometer
  // reading must not reach the UI, where it reads as an argument to use.
  const levers = stripUnreliableOdometerClaims(
    analysisRow?.levers_json ? JSON.parse(analysisRow.levers_json) : [],
    analysisRow?.odometer_seen_km,
    listing.mileage,
  )
  const history = store.priceHistory(adId)
  const budget = store.listSearches().find((s) => s.budget_nok)?.budget_nok ?? undefined

  const plan = row?.fair_value
    ? buildHagglePlan({
        asking: listing.price,
        priceExclRegistration: specs?.price_excl_reg ?? undefined,
        fairValue: row.fair_value,
        confidence: model.confidence ?? "medium",
        levers: levers.map((l: any) => ({ claim: l.claim, evidence: l.evidence, estValueNok: l.estValueNok, source: "bilde" })),
        budget,
        dealerSegment: listing.dealer_segment ?? undefined,
        daysListed: listing.published_at ? Math.floor((Date.now() - listing.published_at) / 86_400_000) : undefined,
        priceDrops: history.slice(0, -1).map((h) => h.price),
      })
    : null

  const flags = analysisRow?.flags_json ? JSON.parse(analysisRow.flags_json) : { red: [], green: [] }

  return json({
    listing: {
      adId,
      heading: listing.heading,
      url: listing.url,
      year: listing.year,
      mileage: listing.mileage,
      price: listing.price,
      fuel: listing.fuel,
      transmission: listing.transmission,
      dealerSegment: listing.dealer_segment,
      location: listing.location,
      regno: listing.regno,
      vin: listing.vin,
      images: listing.image_urls ? JSON.parse(listing.image_urls) : [],
      publishedAt: listing.published_at,
      trip: (() => {
        const home = loadHome()
        if (!home || listing.lat == null || listing.lon == null) return null
        const t = travelCost(home, { lat: listing.lat, lon: listing.lon })
        return { roadKm: Math.round(t.roadKm), costNok: Math.round(t.costNok), hours: t.hours, note: t.note, from: home.label }
      })(),
    },
    condition: row?.condition ?? "running",
    project: row?.project_json ? JSON.parse(row.project_json) : null,
    valuation: row
      ? {
          fairValue: row.fair_value,
          residualPct: row.residual_pct,
          compCount: row.comp_count,
          score: row.score,
          confidence: model.confidence,
          tier: model.tier,
          r2: model.r2,
          perYear: model.perYear,
          per10kKm: model.per10kKm,
          parts: model.parts ?? [],
          requirements: model.requirements ?? [],
        }
      : null,
    // Each comp carries its own ad id so a point in the chart is clickable.
    comps: (selection?.comps ?? []).map((c) => ({ adId: c.ad_id, km: c.mileage, price: c.price, year: c.year })),
    trend,
    plan,
    analysis: analysisRow
      ? {
          redFlags: flags.red ?? [],
          greenFlags: flags.green ?? [],
          levers,
          summary: analysisRow.summary,
          provider: analysisRow.provider,
          odometerSeenKm: analysisRow.odometer_seen_km,
          // Resolving imageIndex needs the images the model actually saw —
          // eight of the listing's sixteen, not the first eight.
          imagesUsed: analysisRow.images_used_json ? JSON.parse(analysisRow.images_used_json) : [],
        }
      : null,
    specs: specs
      ? {
          description: specs.description,
          equipment: specs.equipment_json ? JSON.parse(specs.equipment_json) : [],
          fields: specs.fields_json ? JSON.parse(specs.fields_json) : {},
          euControl: euControlFor(specs, specs.fields_json ? JSON.parse(specs.fields_json)["1. gang registrert"] : undefined),
        }
      : null,
    priceHistory: history,
    watched: store.isWatched(adId),
    relist: (() => {
      const prev = store.relistOf(adId)
      if (!prev) return null
      return {
        previousAdId: prev.ad_id,
        previousPrice: prev.price,
        daysBetween: Math.max(0, Math.round((Date.now() - prev.first_seen) / 86_400_000)),
        stillListed: prev.delisted_at === null,
      }
    })(),
  })
}

async function addSearch(store: Store, request: Request): Promise<Response> {
  const body = (await request.json()) as { name?: string; url?: string; budget?: number; want?: string }
  if (!body.name || !body.url) return json({ error: "name and url are required" }, 400)
  const id = store.addSearch(body.name, normalizeSearchUrl(body.url).toString(), body.budget, 6, parseRequirements(body.want ?? ""))
  return json({ id })
}

function toggleWatch(store: Store, adId: number): Response {
  const exists = store.db.query("SELECT 1 FROM watchlist WHERE ad_id = ?").get(adId) !== null
  if (exists) store.db.query("DELETE FROM watchlist WHERE ad_id = ?").run(adId)
  else store.db.query("INSERT INTO watchlist (ad_id, added_at) VALUES (?, ?)").run(adId, Date.now())
  return json({ watched: !exists })
}

function health(store: Store) {
  const count = (sql: string) => (store.db.query(sql).get() as any)?.n ?? 0
  return {
    listings: count("SELECT COUNT(*) n FROM listings WHERE delisted_at IS NULL"),
    delisted: count("SELECT COUNT(*) n FROM listings WHERE delisted_at IS NOT NULL"),
    valued: count("SELECT COUNT(*) n FROM valuations"),
    analysed: count("SELECT COUNT(*) n FROM analyses"),
    withSpecs: count("SELECT COUNT(*) n FROM specs"),
    searches: store.listSearches(false),
    confidence: store.db.query("SELECT json_extract(model_json,'$.confidence') c, COUNT(*) n FROM valuations GROUP BY c").all(),
    llm: store.llmStats(),
    topModels: store.db
      .query("SELECT make, series, COUNT(*) n FROM listings WHERE delisted_at IS NULL AND make IS NOT NULL GROUP BY make, series ORDER BY n DESC LIMIT 10")
      .all(),
  }
}
