#!/usr/bin/env bun
import { configureHugin, huginStatus, configureOpenRouter, openRouterStatus } from "llm-brain"
import { initBrain, loadBrainConfig, saveBrainConfig, providersFor, huginConfigured, openRouterConfigured } from "./llm/brain.ts"
import { Store, parseSearchRequirements } from "./store.ts"
import { PoliteClient } from "./http.ts"
import { sweepSearch, normalizeSearchUrl } from "./finn/search.ts"
import { parseItemPage } from "./finn/item.ts"
import { analyzeListing } from "./llm/analyze.ts"
import { selectImages } from "./llm/images.ts"
import { isConfigured as vegvesenConfigured, saveAuth as saveVegvesenAuth, lookup as vegvesenLookup, mapVehicle, crossCheck } from "./vegvesen.ts"
import { stateDir } from "./paths.ts"
import { valueAll, enrichTop, type ScoredListing } from "./pipeline.ts"
import { buildHagglePlan } from "./value/haggle.ts"
import { saveNtfyConfig, send, dealNotification } from "./notify/ntfy.ts"
import { buildCorpus } from "./corpus.ts"
import { parseRequirements, formatRequirements, summarise } from "./value/requirements.ts"
import { startServer } from "./server.ts"
import { reap } from "./reap.ts"
import { loadHome, saveHome, resolveHome, setDistanceScoring } from "./home.ts"
import { travelCost } from "./value/distance.ts"

const kr = (n: number) => `${Math.round(n).toLocaleString("nb-NO")} kr`

async function prompt(question: string): Promise<string> {
  process.stdout.write(question)
  for await (const line of console) return line.trim()
  return ""
}

// ---------------------------------------------------------------------------

async function providerCmd(args: string[]): Promise<void> {
  const [which, action] = args
  initBrain()

  if (!which || action === "status" || which === "status") {
    const hugin = await huginStatus()
    const openrouter = await openRouterStatus()
    const config = loadBrainConfig()
    console.log(`state dir:  ${stateDir}`)
    console.log(`primary:    ${config.primary}${config.visionProvider ? `  (vision pinned to ${config.visionProvider})` : ""}`)
    console.log(`hugin:      ${hugin.connected ? "✓" : "✗"} ${hugin.detail}`)
    console.log(`openrouter: ${openrouter.connected ? "✓" : "✗"} ${openrouter.detail} [${config.openrouterModel}]`)
    console.log(`vegvesen:   ${vegvesenConfigured() ? "✓ configured" : "✗ not configured"}`)
    return
  }

  if (which === "hugin" && action === "setup") {
    const cookie = await prompt("Paste the AppServiceAuthSession cookie from hugin.telemarkfylke.no: ")
    await configureHugin(cookie)
    console.log("✓ Hugin connected.")
    return
  }
  if (which === "openrouter" && action === "setup") {
    const key = await prompt("Paste your OpenRouter API key (sk-or-...): ")
    await configureOpenRouter(key)
    console.log("✓ OpenRouter connected.")
    return
  }
  if (which === "vegvesen" && action === "setup") {
    const key = await prompt("Paste your Vegvesen API key (SVV-Authorization Apikey): ")
    if (!key) throw new Error("No key given.")
    saveVegvesenAuth({ kind: "apikey", key })
    console.log("✓ Saved. Verify with `bazaar vv <regnr>`.")
    return
  }
  if (which === "primary" && action) {
    if (action !== "hugin" && action !== "openrouter") throw new Error("primary must be hugin or openrouter")
    saveBrainConfig({ primary: action })
    console.log(`✓ Primary provider is now ${action}.`)
    return
  }
  throw new Error("Usage: bazaar provider [status | hugin setup | openrouter setup | vegvesen setup | primary <hugin|openrouter>]")
}

// ---------------------------------------------------------------------------

async function visionProbe(args: string[]): Promise<void> {
  const adId = Number(args[0])
  if (!Number.isFinite(adId)) throw new Error("Usage: bazaar vision-probe <ad_id>")
  if (!huginConfigured() || !openRouterConfigured())
    throw new Error("The probe compares both providers, so both must be configured. See `bazaar provider status`.")

  const store = new Store()
  const client = new PoliteClient()
  const url = `https://www.finn.no/mobility/item/${adId}`

  console.log(`Fetching ${url} …`)
  const page = await client.get(url)
  const specs = parseItemPage(page.body, adId)

  const row = store.db.query("SELECT heading, year, mileage, price, fuel, transmission, dealer_segment, image_urls FROM listings WHERE ad_id = ?").get(adId) as any
  const imageUrls: string[] = row?.image_urls ? JSON.parse(row.image_urls) : []
  if (imageUrls.length === 0) {
    console.log("\n⚠ No images on record for this ad. Run a sweep that includes it first — image_urls come from the search payload, not the detail page.")
    store.close()
    return
  }

  const images = selectImages(imageUrls)
  console.log(`\nSending ${images.length} photos (640w) to both providers.\n`)
  for (const [i, image] of images.entries()) console.log(`  [${i}] ${image.url}`)

  const input = {
    adId,
    heading: row?.heading ?? specs.fields["Merke"] ?? `Ad ${adId}`,
    year: row?.year ?? undefined,
    mileage: row?.mileage ?? specs.mileage,
    price: row?.price ?? 0,
    fuel: row?.fuel ?? undefined,
    transmission: row?.transmission ?? undefined,
    dealerSegment: row?.dealer_segment ?? undefined,
    description: specs.description,
    equipment: specs.equipment,
    specFields: specs.fields,
    imageUrls,
  }

  const { makeHuginProvider, makeOpenRouterProvider } = await import("llm-brain")
  const config = loadBrainConfig()

  for (const [name, provider] of [
    ["hugin", makeHuginProvider()],
    ["openrouter", makeOpenRouterProvider(config.openrouterModel)],
  ] as const) {
    console.log(`\n${"─".repeat(70)}\n${name.toUpperCase()} (${provider.model})\n${"─".repeat(70)}`)
    const started = Date.now()
    try {
      // No fallback here on purpose: the point is to see what each one does
      // alone, including whether it fails to produce usable JSON at all.
      const result = await analyzeListing(input, { primary: provider, store })
      const a = result.analysis
      console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s${result.escalated ? " (escalated!)" : ""}`)
      console.log(`  odometer read from a photo: ${a.odometerSeenKm ?? "—"}${input.mileage ? `   (ad says ${input.mileage.toLocaleString("nb-NO")})` : ""}`)
      console.log(`\n  RED FLAGS (${a.redFlags.length}):`)
      for (const f of a.redFlags) console.log(`    [${f.source}${f.imageIndex !== undefined ? ` #${f.imageIndex}` : ""}] ${f.claim}\n        ↳ ${f.evidence}`)
      console.log(`\n  GREEN FLAGS (${a.greenFlags.length}):`)
      for (const f of a.greenFlags) console.log(`    [${f.source}] ${f.claim}`)
      console.log(`\n  LEVERS (${a.levers.length}):`)
      for (const l of a.levers) console.log(`    ${kr(l.estValueNok).padStart(12)}  ${l.claim}`)
      console.log(`\n  ${a.summaryNo}`)
    } catch (error) {
      console.log(`  ✗ FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log(`\n${"─".repeat(70)}`)
  console.log("Grade each side yourself against the photos above:")
  console.log("  · did it find defects that are genuinely visible?")
  console.log("  · did it INVENT any? (worse — a hallucinated rust hole becomes a")
  console.log("    negotiating position that collapses when you see the car)")
  console.log("  · could it read the odometer?")
  console.log("\nThen pin vision with:  bazaar provider primary <hugin|openrouter>")
  store.close()
}

// ---------------------------------------------------------------------------

async function sweep(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run")
  const pages = Number(args.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? 2)
  const store = new Store()
  const client = new PoliteClient()
  const searches = store.listSearches()
  if (searches.length === 0) {
    console.log("No searches configured. Add one with:\n  bazaar search add \"<name>\" \"<finn saved-search URL>\" [budget]")
    store.close()
    return
  }

  for (const search of searches) {
    console.log(`\n${search.name}  (${search.url})`)
    const entries = await sweepSearch(client, normalizeSearchUrl(search.url), { maxPages: pages })
    console.log(`  ${entries.length} listings`)
    if (dryRun) {
      console.log("  --dry-run: nothing written")
      continue
    }
    const changes = store.ingest(entries, search.id)
    store.markSwept(search.id)
    const counts = { new: 0, price: 0, relisted: 0 } as Record<string, number>
    for (const change of changes) counts[change.kind]!++
    console.log(`  ${counts.new} new · ${counts.price} price changes · ${counts.relisted} relisted`)
    for (const change of changes) {
      if (change.kind === "price")
        console.log(`    ↓ ${change.entry.heading}: ${kr(change.previous)} → ${kr(change.entry.price.amount)}`)
      if (change.kind === "relisted")
        console.log(`    ♻ ${change.entry.heading}: relisted after ${change.daysBetween}d, was ${kr(change.previousPrice)} now ${kr(change.entry.price.amount)}`)
    }
  }
  store.close()
}

async function searchCmd(args: string[]): Promise<void> {
  const [action, ...rest] = args
  const store = new Store()
  if (action === "add") {
    const positional = rest.filter((a) => !a.startsWith("--"))
    const [name, url, budget] = positional
    // A trailing ! marks a must-have: --want="skinn!, hengerfeste, ryggekamera"
    const requirements = parseRequirements(rest.find((a) => a.startsWith("--want="))?.slice("--want=".length) ?? "")
    if (!name || !url) throw new Error('Usage: bazaar search add "<name>" "<url>" [budget] [--want="skinn!, hengerfeste"]')
    store.addSearch(name, normalizeSearchUrl(url).toString(), budget ? Number(budget) : undefined, 6, requirements)
    console.log(`✓ Added "${name}".${requirements.length ? ` Ønsker: ${formatRequirements(requirements)}` : ""}`)
  } else {
    for (const s of store.listSearches(false)) {
      const reqs = parseSearchRequirements(s)
      console.log(`  [${s.id}] ${s.name}${s.budget_nok ? ` · budsjett ${kr(s.budget_nok)}` : ""}`)
      if (reqs.length) console.log(`      ønsker: ${formatRequirements(reqs)}`)
      console.log(`      ${s.url}`)
    }
  }
  store.close()
}

async function vv(args: string[]): Promise<void> {
  const regno = args[0]
  if (!regno) throw new Error("Usage: bazaar vv <regnr>")
  const raw = await vegvesenLookup({ regno })
  if (!raw) throw new Error("Vegvesen is not configured. Run `bazaar provider vegvesen setup`.")
  const facts = mapVehicle(raw)
  if (!facts) throw new Error("No vehicle data returned.")
  console.log(JSON.stringify(facts, null, 2))
  const notes = crossCheck(facts, {})
  for (const note of notes) console.log(`  ⚠ ${note}`)
}

function serve(args: string[]): void {
  const port = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 3000)
  const host = args.find((a) => a.startsWith("--host="))?.split("=")[1] ?? "0.0.0.0"
  const { url } = startServer({ port, hostname: host })
  console.log(`BazaarAgent on ${url}`)
  console.log("From your phone: use this machine\u2019s Tailscale name, e.g. http://tfpc:" + port)
}

async function homeCmd(args: string[]): Promise<void> {
  const scoreFlag = args.find((a) => a.startsWith("--score="))?.slice("--score=".length)
  const weightFlag = args.find((a) => a.startsWith("--weight="))?.slice("--weight=".length)

  if (scoreFlag || weightFlag) {
    if (scoreFlag && !["on", "off"].includes(scoreFlag)) throw new Error("--score must be on or off")
    const weight = weightFlag === undefined ? undefined : Number(weightFlag)
    if (weight !== undefined && (!Number.isFinite(weight) || weight < 0)) throw new Error("--weight must be a number >= 0")
    const home = setDistanceScoring({ scoreDistance: scoreFlag ? scoreFlag === "on" : undefined, weight })
    console.log(describeHome(home))
    console.log("  Re-run `./bazaar score` to apply it.")
    return
  }

  const input = args.filter((a) => !a.startsWith("--")).join(" ").trim()
  if (!input) {
    const home = loadHome()
    console.log(
      home
        ? `${describeHome(home)}\n  ./bazaar home --score=off        stop distance affecting the score\n  ./bazaar home --weight=0.5       count it, but half as much`
        : 'No home set — distance is not scored.\n  ./bazaar home "Skien"     or     ./bazaar home 59.2,9.6',
    )
    return
  }
  const resolved = await resolveHome(input)
  // Keep an existing preference rather than silently re-enabling scoring when
  // someone just corrects their town.
  const previous = loadHome()
  const home = previous ? { ...resolved, scoreDistance: previous.scoreDistance, weight: previous.weight } : resolved
  saveHome(home)
  console.log(`✓ ${describeHome(home)}`)
  console.log("  Re-run `./bazaar score` to apply it.")
}

function describeHome(home: NonNullable<ReturnType<typeof loadHome>>): string {
  const scoring = home.scoreDistance
    ? home.weight === 1
      ? "teller i scoren"
      : `teller i scoren (vekt ${home.weight})`
    : "vises, men teller ikke i scoren"
  return `Hjemme: ${home.label}  (${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}) — avstand ${scoring}`
}

async function reapCmd(args: string[]): Promise<void> {
  const hours = Number(args.find((a) => a.startsWith("--stale="))?.split("=")[1] ?? 24)
  const max = Number(args.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 40)
  const store = new Store()
  const result = await reap({ store, staleAfterHours: hours, max, onProgress: (l) => console.log(l) })
  console.log(`\nChecked ${result.checked}: ${result.delisted} gone, ${result.stillLive} still listed.`)
  store.close()
}

async function corpus(args: string[]): Promise<void> {
  const pages = Number(args.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? 3)
  const models = Number(args.find((a) => a.startsWith("--models="))?.split("=")[1] ?? 8)
  const store = new Store()
  const result = await buildCorpus({ store, pagesPerModel: pages, maxModels: models, onProgress: (l) => console.log(l) })
  console.log(`\nFetched ${result.swept} listings across ${result.models} model groups.`)
  store.close()
}

async function score(args: string[]): Promise<void> {
  const noLlm = args.includes("--no-llm")
  const limit = Number(args.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 10)
  const store = new Store()
  const budget = store.listSearches().find((s) => s.budget_nok)?.budget_nok ?? undefined

  const { valued, skipped, results } = valueAll({ store, budget: budget ?? undefined })
  console.log(`Valued ${valued} listings (${skipped} skipped — too few comparables).`)

  const enriched = await enrichTop(results, {
    store,
    budget: budget ?? undefined,
    noLlm,
    maxAnalyses: limit,
    onProgress: (line) => console.log(line),
  })

  console.log(`\nTop ${Math.min(enriched.length, 10)}:`)
  for (const deal of enriched.slice(0, 10)) printDeal(deal)
  store.close()
}

function printDeal(deal: ScoredListing): void {
  const { listing, valuation, plan, score } = deal
  const under = valuation.residualPct > 0 ? `${(valuation.residualPct * 100).toFixed(0)}% under` : `${(-valuation.residualPct * 100).toFixed(0)}% over`
  console.log(`\n  [${score.toFixed(1)}] ${listing.heading} ${listing.year} · ${listing.mileage.toLocaleString("nb-NO")} km`)
  console.log(`        ${kr(listing.price)} · ${under} marked (est. ${kr(valuation.fairValue)}, ${valuation.selection.comps.length} comps, ${valuation.confidence})`)
  const home = loadHome()
  const trip = home && listing.lat != null && listing.lon != null ? travelCost(home, { lat: listing.lat, lon: listing.lon }) : undefined
  console.log(`        ${listing.dealer_segment ?? "?"} · ${listing.location ?? "?"}${trip ? ` · ~${Math.round(trip.roadKm)} km (${kr(trip.costNok)} t/r, ${trip.hours.toFixed(1)} t)` : ""}`)
  console.log(`        ${listing.url}`)
  if (plan?.haggleableIntoBudget) console.log(`        💬 ${kr(plan.overBudgetBy!)} over budsjett — forhandlebart ned til ${kr(plan.target)}`)
  else if (plan && plan.target < listing.price) console.log(`        💬 mål ${kr(plan.target)} · gå fra ved ${kr(plan.walkAway)}`)
  for (const finding of deal.registryFindings) console.log(`        ⚠ ${finding}`)
  if (deal.requirements?.length) {
    const icon = { ja: "✓", nei: "✗", kanskje: "?" }
    console.log(`        ${deal.requirements.map((r) => `${icon[r.status]} ${r.requirement}`).join("   ")}`)
  }
  if (deal.analysis) {
    for (const flag of deal.analysis.redFlags.slice(0, 3)) console.log(`        · ${flag.claim}`)
  }
}

async function deals(args: string[]): Promise<void> {
  const minScore = Number(args.find((a) => a.startsWith("--min="))?.split("=")[1] ?? 0)
  const store = new Store()
  const rows = store.topDeals(20, minScore)
  if (rows.length === 0) {
    console.log("Nothing scored yet. Run `./bazaar score`.")
    store.close()
    return
  }
  for (const r of rows) {
    const under = r.residual_pct !== null ? `${(r.residual_pct * 100).toFixed(0)}%` : "?"
    console.log(`[${(r.score ?? 0).toFixed(1)}] ${kr(r.price).padStart(12)}  ${under.padStart(5)} under  ${String(r.year ?? "").padEnd(5)} ${String(r.heading).slice(0, 34).padEnd(34)} ${r.url}`)
  }
  store.close()
}

async function plan(args: string[]): Promise<void> {
  const adId = Number(args[0])
  if (!Number.isFinite(adId)) throw new Error("Usage: ./bazaar plan <ad_id>")
  const store = new Store()
  const row = store.topDeals(500).find((d) => d.ad_id === adId)
  if (!row) throw new Error(`Ad ${adId} has not been scored. Run \`./bazaar score\` first.`)

  const listing = store.listing(adId)!
  const specs = store.specs(adId)
  const levers = row.levers_json ? JSON.parse(row.levers_json) : []
  const budget = store.listSearches().find((s) => s.budget_nok)?.budget_nok ?? undefined
  const history = store.priceHistory(adId)

  const p = buildHagglePlan({
    asking: listing.price,
    priceExclRegistration: specs?.price_excl_reg ?? undefined,
    fairValue: row.fair_value ?? listing.price,
    confidence: (JSON.parse(row.model_json ?? "{}").confidence ?? "medium") as any,
    levers: levers.map((l: any) => ({ claim: l.claim, evidence: l.evidence, estValueNok: l.estValueNok, source: "bilde" })),
    budget: budget ?? undefined,
    dealerSegment: listing.dealer_segment ?? undefined,
    daysListed: listing.published_at ? Math.floor((Date.now() - listing.published_at) / 86_400_000) : undefined,
    priceDrops: history.slice(0, -1).map((h) => h.price),
  })

  console.log(`${listing.heading} ${listing.year} · ${listing.mileage.toLocaleString("nb-NO")} km`)
  console.log(listing.url)
  console.log(`\n  Prisantydning   ${kr(p.asking).padStart(12)}`)
  if (p.omregFee) console.log(`  Omregistrering  ${kr(p.omregFee).padStart(12)}\n  Totalt          ${kr(p.totalCost).padStart(12)}`)
  console.log(`  Markedsverdi    ${kr(p.fairValue).padStart(12)}`)
  console.log(`  Forsvarlig      ${kr(p.defensibleValue).padStart(12)}   (etter ${kr(p.leverTotal)} i funn)`)
  console.log(`\n  MÅLPRIS         ${kr(p.target).padStart(12)}`)
  console.log(`  Gå fra ved      ${kr(p.walkAway).padStart(12)}`)
  if (p.budget) console.log(`  Budsjett        ${kr(p.budget).padStart(12)}${p.haggleableIntoBudget ? "   ✓ innen rekkevidde" : p.overBudgetBy ? "   ✗ for dyrt" : ""}`)
  console.log("\n  Argumenter:")
  for (const line of p.rationale) console.log(`    ${line}`)
  if (row.summary) console.log(`\n  ${row.summary}`)
  store.close()
}

async function notifyCmd(args: string[]): Promise<void> {
  const [action] = args
  if (action === "setup") {
    const server = (await prompt("ntfy server [https://ntfy.sh]: ")) || "https://ntfy.sh"
    const topic = await prompt("Topic (pick something unguessable, e.g. bazaar-a7f3k2): ")
    if (!topic) throw new Error("A topic is required.")
    const token = await prompt("Bearer token (blank for none): ")
    saveNtfyConfig({ server, topic, token: token || undefined })
    console.log(`✓ Saved. Subscribe to "${topic}" in the ntfy app on your phone and desktop.`)
    return
  }
  if (action === "test") {
    const ok = await send({ title: "BazaarAgent", body: "Varsler virker. 🚗", tags: ["white_check_mark"], priority: 3 })
    console.log(ok ? "✓ Sent." : "✗ Failed — is ntfy configured? Run `./bazaar notify setup`.")
    return
  }

  // Send anything scoring high enough that has not already been sent.
  const store = new Store()
  const searches = store.listSearches()
  const minScore = Number(args.find((a) => a.startsWith("--min="))?.split("=")[1] ?? Math.min(...searches.map((s) => s.min_score), 6))
  // A cap, because the first run after setup always faces a backlog — 30 deals
  // had accumulated here — and thirty notifications at once is not an alert,
  // it is noise you will mute. The best few go now, the rest next tick.
  const max = Number(args.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 5)
  const budget = searches.find((s) => s.budget_nok)?.budget_nok ?? undefined
  let sent = 0
  let failed = 0

  const pending = store.topDeals(60, minScore).filter((row) => !store.wasNotified(row.ad_id, "deal"))

  // Clear a backlog without sending it: useful right after configuring a
  // channel, when everything already in the feed is old news.
  if (args.includes("--catch-up")) {
    for (const row of pending) store.markNotified(row.ad_id, "deal")
    console.log(`Marked ${pending.length} existing deals as seen. Only new ones will alert from now on.`)
    store.close()
    return
  }

  for (const row of pending.slice(0, max)) {
    const listing = store.listing(row.ad_id)
    if (!listing) continue
    const ok = await send(
      dealNotification(
        {
          listing,
          valuation: { fairValue: row.fair_value ?? 0, residualPct: row.residual_pct ?? 0 } as any,
          score: row.score ?? 0,
          parts: [],
          registryFindings: [],
        },
        budget ?? undefined,
      ),
    )
    // Record it ONLY once it actually went out. Marking first burns the deal
    // permanently when the send fails — which is exactly what happened while
    // ntfy was unconfigured: 46 cars marked sent, none delivered, and none
    // that would ever be retried.
    if (ok) {
      store.markNotified(row.ad_id, "deal")
      sent++
    } else {
      failed++
    }
  }
  const remaining = Math.max(0, pending.length - max)
  console.log(
    `${sent} notification${sent === 1 ? "" : "s"} sent.` +
      (failed ? ` ${failed} failed and will be retried — is ntfy configured?` : "") +
      (remaining ? ` ${remaining} more queued (capped at ${max} per run; --catch-up to clear without sending).` : ""),
  )
  store.close()
}

async function llmStats(): Promise<void> {
  const store = new Store()
  const rows = store.llmStats()
  if (rows.length === 0) {
    console.log("No LLM calls recorded yet.")
  } else {
    console.log("task                provider     calls   ok   escalations   avg ms")
    for (const r of rows)
      console.log(
        `${r.task.padEnd(20)}${r.provider.padEnd(13)}${String(r.calls).padStart(5)}${String(r.ok).padStart(5)}${String(r.escalations).padStart(14)}${String(r.p50_ms).padStart(9)}`,
      )
  }
  store.close()
}

// ---------------------------------------------------------------------------

const USAGE = `bazaar — finn.no deal hunter

  provider status                      show configured providers
  provider hugin setup                 paste a Hugin session cookie
  provider openrouter setup            paste an OpenRouter API key
  provider vegvesen setup              paste a Vegvesen API key
  provider primary <hugin|openrouter>  choose the first provider tried

  search add "<name>" "<url>" [budget] [--want="skinn!, hengerfeste"]
                                       watch a saved search; ! marks a must-have
  search list                          show configured searches
  sweep [--pages=N] [--dry-run]        run one pass over every search

  serve [--port=N] [--host=H]          web UI for phone and desktop
  home ["Skien" | lat,lon]             set where you are
  home --score=on|off [--weight=N]     whether distance affects the score
  reap [--stale=H] [--max=N]           verify stale listings; retire the sold ones
  corpus [--pages=N] [--models=N]      deepen comparables for watched models
  score [--no-llm] [--max=N]           value, enrich and rank everything swept
  deals [--min=N]                      show the ranked feed
  plan <ad_id>                         full haggle plan for one car
  notify setup | test                  configure ntfy, or send a test
  notify [--max=N] [--min=S] [--catch-up]
                                       push new deals; cap per run, or clear the backlog
  notify                               push anything new above the threshold

  vision-probe <ad_id>                 compare both providers on one ad's photos
  vv <regnr>                           look a plate up in the Vegvesen registry
  llm stats                            escalation rate per task and provider
`

const [command, ...rest] = process.argv.slice(2)
try {
  switch (command) {
    case "provider": await providerCmd(rest); break
    case "search": await searchCmd(rest); break
    case "sweep": await sweep(rest); break
    case "vision-probe": await visionProbe(rest); break
    case "vv": await vv(rest); break
    case "serve": serve(rest); break
    case "home": await homeCmd(rest); break
    case "reap": await reapCmd(rest); break
    case "corpus": await corpus(rest); break
    case "score": await score(rest); break
    case "deals": await deals(rest); break
    case "plan": await plan(rest); break
    case "notify": await notifyCmd(rest); break
    case "llm": await llmStats(); break
    default: console.log(USAGE)
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
