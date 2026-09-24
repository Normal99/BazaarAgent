import { Store, type ListingRow } from "./store.ts"
import { PoliteClient } from "./http.ts"
import { parseItemPage } from "./finn/item.ts"
import { valueListing, isFailure, type Valuation } from "./value/comps.ts"
import { scoreListing, looksLikePartsCar, odometerDiscrepancy, stripUnreliableOdometerClaims, SUSPICION_THRESHOLD } from "./value/score.ts"
import { matchAll, summarise, type Requirement, type RequirementMatch } from "./value/requirements.ts"
import { travelCost, distancePenalty } from "./value/distance.ts"
import { classifyCondition, detectFaults, estimateRepair, assessProject, projectScore, type ProjectAssessment } from "./value/project.ts"
import { loadHome } from "./home.ts"
import { buildHagglePlan, type HagglePlan, type Lever } from "./value/haggle.ts"
import { analyzeListing, type Analysis } from "./llm/analyze.ts"
import { providersFor } from "./llm/brain.ts"
import { lookup as vegvesenLookup, mapVehicle, crossCheck, isConfigured as vegvesenConfigured, inferEuControl } from "./vegvesen.ts"

// The spine: swept listings in, ranked deals out.
//
// The ordering is deliberate and mostly about cost. Valuation is free, so
// everything gets valued. Detail pages are one HTTP request each, so only
// listings that already look interesting get fetched. The LLM is the expensive
// step in both time and money, so it runs last and only on what survived.
//
// Nothing here invents a number when the evidence is thin: a listing with too
// few comparables is left unscored rather than scored badly.

export interface PipelineOptions {
  readonly store: Store
  readonly client?: PoliteClient
  /** Minimum residual to bother enriching. Cars at or above market are not deals. */
  readonly minResidual?: number
  /** Skip the LLM entirely. */
  readonly noLlm?: boolean
  /** Cap on LLM calls per run, so one sweep cannot run away with the budget. */
  readonly maxAnalyses?: number
  readonly budget?: number
  /** Include cars that need work, judged on what is left after fixing them. */
  readonly projects?: boolean
  /** Total to have in a project car, bought and repaired. Defaults to budget. */
  readonly projectBudget?: number
  /** Defaults to the union across active searches. */
  readonly requirements?: readonly Requirement[]
  readonly onProgress?: (line: string) => void
}

export interface ScoredListing {
  readonly listing: ListingRow
  readonly valuation: Valuation
  readonly score: number
  readonly parts: Array<{ label: string; delta: number }>
  readonly analysis?: Analysis
  readonly plan?: HagglePlan
  readonly registryFindings: string[]
  readonly requirements?: RequirementMatch[]
  readonly condition?: "running" | "project" | "scrap"
  readonly project?: ProjectAssessment
}

/** Value every live listing. Free, so it runs over everything. */
export function valueAll(options: PipelineOptions): { valued: number; skipped: number; results: ScoredListing[] } {
  const { store } = options
  const results: ScoredListing[] = []
  const home = loadHome()
  let skipped = 0

  for (const listing of store.valuationCandidates()) {
    const valuation = valueListing(
      store,
      {
        adId: listing.ad_id,
        make: listing.make ?? "",
        model: listing.model,
        series: listing.series,
        year: listing.year,
        mileage: listing.mileage,
        fuel: listing.fuel,
        transmission: listing.transmission,
      },
      listing.price,
    )

    if (isFailure(valuation)) {
      skipped++
      continue
    }

    const history = store.priceHistory(listing.ad_id)
    const { score, parts } = scoreListing({
      residualPct: valuation.residualPct,
      confidence: valuation.confidence,
      year: listing.year,
      mileage: listing.mileage,
      dealerSegment: listing.dealer_segment,
      publishedAt: listing.published_at,
      priceDrops: Math.max(0, history.length - 1),
      distance: distanceFor(home, listing),
      isAuction: listing.listing_type === "auction",
    })

    store.saveValuation(listing.ad_id, {
      fairValue: valuation.fairValue,
      residualPct: valuation.residualPct,
      compCount: valuation.selection.comps.length,
      score,
      model: {
        tier: valuation.selection.tier,
        confidence: valuation.confidence,
        confidenceScore: valuation.confidenceScore,
        r2: valuation.model.r2,
        perYear: valuation.model.perYear,
        per10kKm: valuation.model.per10kKm,
        parts,
      },
    })

    results.push({ listing, valuation, score, parts, registryFindings: [] })
  }

  results.sort((a, b) => b.score - a.score)
  return { valued: results.length, skipped, results }
}

/**
 * Enrich and analyse the best candidates.
 *
 * The gate is confidence first, residual second. A car that looks 20% underpriced
 * on six mismatched comparables is not worth an LLM call, let alone a
 * notification — low-confidence valuations run 16.9% median error against 2.7%
 * for high, so acting on them is acting on noise.
 */
export async function enrichTop(candidates: ScoredListing[], options: PipelineOptions): Promise<ScoredListing[]> {
  const { store } = options
  const client = options.client ?? new PoliteClient()
  const minResidual = options.minResidual ?? 0.03
  const maxAnalyses = options.maxAnalyses ?? 10
  const log = options.onProgress ?? (() => {})

  // Projects hide from the ordinary gate, and would hide from themselves
  // without this. A car that does not run is far under market, which trips the
  // "too good to be true" penalty added to catch parts cars — so it scores
  // badly, never gets its detail page fetched, and can never be recognised as
  // a project in the first place. In projects mode the deeply-underpriced are
  // admitted precisely because they are suspicious: that is where the broken
  // ones live.
  const worth = candidates.filter((c) => {
    if (c.valuation.confidence === "low") return false
    if (c.valuation.residualPct >= minResidual) return true
    if (options.budget !== undefined && c.listing.price > options.budget) return true
    return false
  })
  // They are not merely absent from the queue, they are buried in it: the
  // suspicion penalty pushes them to the bottom by score, and a --max of 30
  // never reaches them. So in projects mode they are promoted, not appended.
  const isSuspicious = (c: ScoredListing) => c.valuation.residualPct > SUSPICION_THRESHOLD
  const suspicious = options.projects ? worth.filter(isSuspicious) : []
  if (suspicious.length > 0) log(`${suspicious.length} deeply underpriced — checking whether they are projects rather than wrecks`)

  // Interleaved rather than front-loaded: one --max should not be spent
  // entirely on one kind.
  const queue = options.projects ? [] : [...worth]
  if (options.projects) {
    const ordinary = worth.filter((c) => !isSuspicious(c))
    const maxLen = Math.max(ordinary.length, suspicious.length)
    for (let i = 0; i < maxLen; i++) {
      if (i < ordinary.length) queue.push(ordinary[i]!)
      if (i < suspicious.length) queue.push(suspicious[i]!)
    }
  }
  log(`${queue.length} of ${candidates.length} worth enriching (confidence ≥ medium, residual ≥ ${(minResidual * 100).toFixed(0)}%)`)

  const out: ScoredListing[] = []
  let analysed = 0

  for (const candidate of queue.slice(0, maxAnalyses)) {
    const { listing } = candidate
    let specs = store.specs(listing.ad_id)

    if (!specs) {
      try {
        const page = await client.get(listing.url)
        if (!page.notModified) {
          const parsed = parseItemPage(page.body, listing.ad_id)
          store.saveSpecs(parsed)
          specs = store.specs(listing.ad_id)
        }
      } catch (error) {
        log(`  ${listing.ad_id}: detail fetch failed — ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // The registry is the one source the seller does not control, so a
    // disagreement here outranks anything in the ad.
    const registryFindings: string[] = []
    if (vegvesenConfigured() && listing.regno) {
      try {
        const facts = mapVehicle(await vegvesenLookup({ regno: listing.regno }))
        if (facts) registryFindings.push(...crossCheck(facts, { mileage: listing.mileage, year: listing.year }))
      } catch {
        // A registry miss must never block a deal from being scored.
      }
    }

    // A car that cannot be driven home is not a bargain — unless you own a
    // workshop, in which case it is the whole point. So classify rather than
    // disqualify: scrap is still thrown out, but a known, bounded fault is
    // priced instead.
    const condition = classifyCondition(specs?.description)
    const partsCar = looksLikePartsCar(specs?.description)

    if (condition === "scrap" || (partsCar.hit && condition !== "project")) {
      store.saveValuation(listing.ad_id, {
        fairValue: candidate.valuation.fairValue,
        residualPct: candidate.valuation.residualPct,
        compCount: candidate.valuation.selection.comps.length,
        score: 0,
        condition: "scrap",
        model: { tier: candidate.valuation.selection.tier, confidence: candidate.valuation.confidence, disqualified: `ikke kjørbar: «${partsCar.phrase ?? "delebil"}»` },
      })
      log(`  ${listing.ad_id}: skipped — «${partsCar.phrase ?? "delebil"}»`)
      continue
    }

    // The comps are all running cars, so fairValue is what this is worth once
    // it works. That is exactly the number a project needs measuring against.
    let project: ProjectAssessment | undefined
    if (condition === "project") {
      if (!options.projects) {
        log(`  ${listing.ad_id}: prosjektbil, hoppet over (bruk --projects)`)
        continue
      }
      const repair = estimateRepair(detectFaults(specs?.description))
      project = assessProject({
        fairValueWorking: candidate.valuation.fairValue,
        asking: listing.price,
        repair,
        budget: options.projectBudget ?? options.budget,
        omregFee:
          specs?.price_excl_reg && specs.price_excl_reg > 0 && specs.price_excl_reg < listing.price
            ? listing.price - specs.price_excl_reg
            : undefined,
      })
      log(
        `  ${listing.ad_id}: prosjekt — ${repair.faults.map((f) => f.label).join(", ")} · ` +
          `reparasjon ${repair.lowNok.toLocaleString("nb-NO")}–${repair.highNok.toLocaleString("nb-NO")} kr · ` +
          `margin ${Math.round(project.headroomLow).toLocaleString("nb-NO")} kr${project.viable ? "" : " (for tynn)"}`,
      )
    }

    const fields: Record<string, string> = specs?.fields_json ? JSON.parse(specs.fields_json) : {}
    const equipment: string[] = specs?.equipment_json ? JSON.parse(specs.equipment_json) : []
    const imageUrls: string[] = listing.image_urls ? JSON.parse(listing.image_urls) : []

    // Settle what the text can settle before paying the model to look. finn's
    // equipment list is the most reliable source available and it is free.
    const requirements = options.requirements ?? store.requirementsFor(listing.ad_id)
    let matches = matchAll(requirements, {
      equipment,
      modelSpecification: candidate.listing.model ? fields["Modell"] : undefined,
      description: specs?.description,
      fields,
    })
    const openRequirements = matches.filter((m) => m.status === "kanskje").map((m) => ({ text: m.requirement, required: m.required }))

    let analysis: Analysis | undefined
    let levers: Lever[] = []

    if (!options.noLlm && analysed < maxAnalyses) {
      if (store.hasAnalysis(listing.ad_id)) {
        const row = store.db.query("SELECT flags_json, levers_json, summary FROM analyses WHERE ad_id = ?").get(listing.ad_id) as any
        levers = JSON.parse(row.levers_json)
      } else {
        try {
          const { primary, fallback } = providersFor(imageUrls.length > 0)
          const result = await analyzeListing(
            {
              adId: listing.ad_id,
              heading: listing.heading,
              year: listing.year,
              mileage: listing.mileage,
              price: listing.price,
              fuel: listing.fuel ?? undefined,
              transmission: listing.transmission ?? undefined,
              dealerSegment: listing.dealer_segment ?? undefined,
              description: specs?.description ?? undefined,
              equipment,
              specFields: fields,
              imageUrls,
              registryNotes: registryFindings,
              openRequirements,
            },
            { primary, fallback, store: store },
          )
          analysis = result.analysis
          analysed++
          // The model only saw the open ones, so its answers override
          // "kanskje" and never a confirmed text match.
          if (analysis.requirements?.length) {
            const answered = new Map(analysis.requirements.map((r) => [r.requirement.toLowerCase(), r]))
            matches = matches.map((m) => {
              if (m.status !== "kanskje") return m
              const a = answered.get(m.requirement.toLowerCase())
              return a ? { ...m, status: a.status, evidence: a.evidence ?? undefined, source: (a.source ?? "ukjent") as RequirementMatch["source"] } : m
            })
          }
          levers = analysis.levers.map((l) => ({ claim: l.claim, evidence: l.evidence, estValueNok: l.estValueNok, source: "bilde" as const }))
          store.saveAnalysis(listing.ad_id, {
            flags: { red: analysis.redFlags, green: analysis.greenFlags },
            levers: analysis.levers,
            odometerSeenKm: analysis.odometerSeenKm,
            // Stored so imageIndex resolves to the right photo: the model saw
            // eight of the listing's images, not all of them.
            imagesUsed: result.images.map((i) => i.url),
            summary: analysis.summaryNo,
            provider: result.provider,
            requirements: matches,
          })
          log(`  ${listing.ad_id}: ${analysis.redFlags.length} røde flagg, ${analysis.levers.length} prutepunkt (${result.provider}${result.escalated ? ", eskalert" : ""})`)
        } catch (error) {
          log(`  ${listing.ad_id}: analysis failed — ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    for (const finding of registryFindings) levers.push({ claim: finding, evidence: "Statens vegvesen", estValueNok: 0, source: "register" })

    // Photo odometer readings are not reliable to the digit, so a small gap is
    // dropped rather than presented as a discrepancy. Only a difference too
    // large to be a misread survives, and it survives as something to check.
    //
    // The same gate has to be applied to the model's own prose, not just to
    // our generated note: it will quote the number it thought it read, and a
    // negotiating point built on a misreading collapses in front of the car.
    if (analysis?.odometerSeenKm != null) {
      const check = odometerDiscrepancy(analysis.odometerSeenKm, listing.mileage)
      if (check.material) registryFindings.push(check.note!)
      else levers = stripUnreliableOdometerClaims(levers, analysis.odometerSeenKm, listing.mileage)
    }

    const history = store.priceHistory(listing.ad_id)
    const plan = buildHagglePlan({
      asking: listing.price,
      priceExclRegistration: specs?.price_excl_reg ?? undefined,
      fairValue: candidate.valuation.fairValue,
      confidence: candidate.valuation.confidence,
      levers,
      budget: options.budget,
      dealerSegment: listing.dealer_segment ?? undefined,
      daysListed: listing.published_at ? Math.floor((Date.now() - listing.published_at) / 86_400_000) : undefined,
      priceDrops: history.slice(0, -1).map((h) => h.price),
    })

    // Rescore now that defects and registry findings are known.
    const { score, parts } = scoreListing({
      residualPct: candidate.valuation.residualPct,
      confidence: candidate.valuation.confidence,
      year: listing.year,
      mileage: listing.mileage,
      dealerSegment: listing.dealer_segment,
      publishedAt: listing.published_at,
      priceDrops: Math.max(0, history.length - 1),
      leverTotal: plan.leverTotal,
      fairValue: candidate.valuation.fairValue,
      registryFindings: registryFindings.length,
      requirementDelta: summarise(matches).scoreDelta,
      distance: distanceFor(loadHome(), listing),
      isAuction: listing.listing_type === "auction",
    })
    // A project is not ranked by how far under market it is — of course it is
    // under market, it does not run. It is ranked by what is left afterwards.
    const finalScore = project ? projectScore(project, candidate.valuation.fairValue) : score

    store.saveValuation(listing.ad_id, {
      fairValue: candidate.valuation.fairValue,
      residualPct: candidate.valuation.residualPct,
      compCount: candidate.valuation.selection.comps.length,
      score: finalScore,
      condition,
      project,
      model: { tier: candidate.valuation.selection.tier, confidence: candidate.valuation.confidence, parts, requirements: matches },
    })

    out.push({ ...candidate, score: finalScore, parts, analysis, plan, registryFindings, requirements: matches, condition, project })
  }

  out.sort((a, b) => b.score - a.score)
  return out
}

/** EU-kontroll from the registry where we have it, otherwise the rule, clearly marked. */
export function euControlFor(specs: { eu_control_due: string | null } | null, firstRegistered?: string): { text: string; verified: boolean } {
  if (specs?.eu_control_due) return { text: specs.eu_control_due, verified: true }
  const inferred = inferEuControl(firstRegistered)
  return inferred ? { text: `~${inferred.dueYear} (beregnet)`, verified: false } : { text: "ukjent", verified: false }
}

/**
 * Distance scoring for one listing.
 *
 * Undefined — meaning no effect on the score — when no home is set, when the
 * ad has no coordinates, or when distance scoring is switched off. The last
 * case still leaves distance visible everywhere it is displayed; only the
 * ranking stops caring.
 */
function distanceFor(home: ReturnType<typeof loadHome>, listing: ListingRow): { delta: number; label: string } | undefined {
  if (!home || !home.scoreDistance || listing.lat == null || listing.lon == null) return undefined
  const penalty = distancePenalty(travelCost(home, { lat: listing.lat, lon: listing.lon }).roadKm)
  if (home.weight === 1) return penalty
  return { ...penalty, delta: penalty.delta * home.weight }
}
