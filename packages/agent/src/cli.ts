#!/usr/bin/env bun
import { configureHugin, huginStatus, configureOpenRouter, openRouterStatus } from "llm-brain"
import { initBrain, loadBrainConfig, saveBrainConfig, providersFor, huginConfigured, openRouterConfigured } from "./llm/brain.ts"
import { Store } from "./store.ts"
import { PoliteClient } from "./http.ts"
import { sweepSearch, normalizeSearchUrl } from "./finn/search.ts"
import { parseItemPage } from "./finn/item.ts"
import { analyzeListing } from "./llm/analyze.ts"
import { selectImages } from "./llm/images.ts"
import { isConfigured as vegvesenConfigured, saveAuth as saveVegvesenAuth, lookup as vegvesenLookup, mapVehicle, crossCheck } from "./vegvesen.ts"
import { stateDir } from "./paths.ts"

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
    const changes = store.ingest(entries)
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
    const [name, url, budget] = rest
    if (!name || !url) throw new Error('Usage: bazaar search add "<name>" "<url>" [budget]')
    store.addSearch(name, normalizeSearchUrl(url).toString(), budget ? Number(budget) : undefined)
    console.log(`✓ Added "${name}".`)
  } else {
    for (const s of store.listSearches(false))
      console.log(`  [${s.id}] ${s.name}${s.budget_nok ? ` · budget ${kr(s.budget_nok)}` : ""}\n      ${s.url}`)
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

  search add "<name>" "<url>" [budget] watch a finn saved-search URL
  search list                          show configured searches
  sweep [--pages=N] [--dry-run]        run one pass over every search

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
    case "llm": await llmStats(); break
    default: console.log(USAGE)
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
