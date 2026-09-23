import type { CompRow, Store } from "../store.ts"

// Valuing a car against its market is the part that has to be right: every
// downstream number — the deal score, the haggle target, whether a notification
// fires at all — is a function of "what is this actually worth?". Get it wrong
// and the agent confidently recommends bad cars.
//
// Two decisions carry most of the weight.
//
// 1. Which cars count as comparable. finn's `model` is a generation ("Golf VII")
//    and its `series` is a family ("Golf-Serie"); neither alone is right, so
//    this walks a ladder from narrow to wide and stops as soon as it has enough.
// 2. What to do with them. A trimmed log-linear fit on age and mileage, because
//    finn is full of outliers (parts cars at 3 299 kr, misfiled classics) and a
//    plain mean would be dragged around by them.

export interface ValuationTarget {
  readonly adId?: number
  readonly make: string
  readonly model?: string | null
  readonly series?: string | null
  readonly year: number
  readonly mileage: number
  readonly fuel?: string | null
  readonly transmission?: string | null
}

export type TierName =
  | "generation+transmission"
  | "generation"
  | "generation±3y"
  | "series"
  | "series±3y"
  | "series±5y"

export interface CompSelection {
  readonly comps: CompRow[]
  readonly tier: TierName
  readonly yearFrom: number
  readonly yearTo: number
  /** How the set was described, for the UI to show instead of a bare number. */
  readonly description: string
}

/** Below this, widen. */
const PREFERRED_MIN = 8
/** Below this, refuse to value at all. */
export const HARD_MIN = 5

/**
 * Walk from the tightest defensible comparable set to the widest acceptable one.
 *
 * Fuel is fixed at every rung and never widened away: an e-Golf lives inside
 * "Golf-Serie" but follows a completely different value curve, and letting one
 * into a petrol comp set poisons the estimate. Transmission is dropped early
 * because it moves price much less than it fragments the sample.
 */
export function selectComps(store: Store, target: ValuationTarget): CompSelection | undefined {
  const { make, model, series, year, fuel, transmission } = target

  const rungs: Array<{ tier: TierName; span: number; useSeries: boolean; withTransmission: boolean }> = [
    { tier: "generation+transmission", span: 2, useSeries: false, withTransmission: true },
    { tier: "generation", span: 2, useSeries: false, withTransmission: false },
    { tier: "generation±3y", span: 3, useSeries: false, withTransmission: false },
    { tier: "series", span: 2, useSeries: true, withTransmission: false },
    { tier: "series±3y", span: 3, useSeries: true, withTransmission: false },
    { tier: "series±5y", span: 5, useSeries: true, withTransmission: false },
  ]

  let best: CompSelection | undefined

  for (const rung of rungs) {
    // Skip rungs whose grouping key this listing does not have. `series` is
    // null for a fair few models (Amarok, ID.3, Multivan), and `model` can be
    // missing on sparse ads.
    if (rung.useSeries && !series) continue
    if (!rung.useSeries && !model) continue

    const yearFrom = year - rung.span
    const yearTo = year + rung.span
    const comps = store.comparables({
      make,
      model: rung.useSeries ? undefined : model!,
      series: rung.useSeries ? series! : undefined,
      yearFrom,
      yearTo,
      fuel: fuel ?? undefined,
      transmission: rung.withTransmission ? (transmission ?? undefined) : undefined,
      excludeAdId: target.adId,
    })

    const selection: CompSelection = {
      comps,
      tier: rung.tier,
      yearFrom,
      yearTo,
      description: describe(rung.tier, comps.length, yearFrom, yearTo),
    }
    // Remember the widest attempt so a near-miss can still be reported.
    if (!best || comps.length > best.comps.length) best = selection
    if (comps.length >= PREFERRED_MIN) return selection
  }

  return best
}

const describe = (tier: TierName, n: number, from: number, to: number): string =>
  `${n} comparable${n === 1 ? "" : "s"} · ${tier.startsWith("series") ? "same series" : "same generation"} · ${from}–${to}`

// ---------------------------------------------------------------------------
// Price model
// ---------------------------------------------------------------------------

export interface PriceModel {
  /** Predicted price for a given age and mileage. */
  predict(ageYears: number, mileage: number): number
  readonly n: number
  /** Share of log-price variance explained; low means do not trust the estimate. */
  readonly r2: number
  /** Annual depreciation implied by the fit, as a fraction (0.12 = 12%/yr). */
  readonly perYear: number
  /** Price change per 10 000 km, as a fraction. */
  readonly per10kKm: number
  readonly dropped: number
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Median absolute deviation — an outlier-resistant stand-in for standard deviation. */
const mad = (values: number[], centre: number): number => median(values.map((v) => Math.abs(v - centre)))

/**
 * Fit log(price) ~ a + b·age + c·(mileage/10 000) by least squares, then trim
 * the worst outliers and refit once.
 *
 * Working in log space makes depreciation multiplicative, which is how cars
 * actually lose value — a flat kroner-per-year term would badly misprice both
 * ends of the range. The trim pass is what keeps a 3 299 kr parts car from
 * dragging the whole curve down; ordinary least squares alone has no defence
 * against it.
 */
export function fitPriceModel(comps: readonly CompRow[], currentYear = new Date().getFullYear()): PriceModel | undefined {
  const clean = comps.filter(
    (comp) => comp.price > 1000 && comp.mileage >= 0 && comp.mileage < 1_500_000 && comp.year > 1950 && comp.year <= currentYear + 1,
  )
  if (clean.length < HARD_MIN) return undefined

  type Point = { age: number; km: number; logPrice: number }
  const points: Point[] = clean.map((comp) => ({
    age: currentYear - comp.year,
    km: comp.mileage / 10_000,
    logPrice: Math.log(comp.price),
  }))

  const solve = (rows: Point[]): { a: number; b: number; c: number } | undefined => {
    // Normal equations for a 3-parameter linear fit, solved by Gaussian
    // elimination. Three unknowns does not justify a matrix library.
    const n = rows.length
    let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0
    for (const p of rows) {
      sx += p.age
      sy += p.km
      sz += p.logPrice
      sxx += p.age * p.age
      syy += p.km * p.km
      sxy += p.age * p.km
      sxz += p.age * p.logPrice
      syz += p.km * p.logPrice
    }
    const m: number[][] = [
      [n, sx, sy, sz],
      [sx, sxx, sxy, sxz],
      [sy, sxy, syy, syz],
    ]
    for (let col = 0; col < 3; col++) {
      let pivot = col
      for (let row = col + 1; row < 3; row++) if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row
      if (Math.abs(m[pivot]![col]!) < 1e-10) return undefined // collinear: e.g. every comp the same year
      ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
      for (let row = 0; row < 3; row++) {
        if (row === col) continue
        const factor = m[row]![col]! / m[col]![col]!
        for (let k = col; k < 4; k++) m[row]![k]! -= factor * m[col]![k]!
      }
    }
    return { a: m[0]![3]! / m[0]![0]!, b: m[1]![3]! / m[1]![1]!, c: m[2]![3]! / m[2]![2]! }
  }

  let fit = solve(points)
  if (!fit) return undefined

  // Trim points more than 2.5 MADs from the fit and solve again.
  const residuals = points.map((p) => p.logPrice - (fit!.a + fit!.b * p.age + fit!.c * p.km))
  const centre = median(residuals)
  const spread = mad(residuals, centre)
  const kept = spread > 0 ? points.filter((_, i) => Math.abs(residuals[i]! - centre) <= 2.5 * spread) : points
  const dropped = points.length - kept.length
  if (kept.length >= HARD_MIN) {
    const refit = solve(kept)
    if (refit) fit = refit
  }

  const used = kept.length >= HARD_MIN ? kept : points
  const meanLog = used.reduce((sum, p) => sum + p.logPrice, 0) / used.length
  const ssTot = used.reduce((sum, p) => sum + (p.logPrice - meanLog) ** 2, 0)
  const ssRes = used.reduce((sum, p) => sum + (p.logPrice - (fit!.a + fit!.b * p.age + fit!.c * p.km)) ** 2, 0)
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

  return {
    n: used.length,
    r2,
    dropped,
    perYear: 1 - Math.exp(fit.b),
    per10kKm: 1 - Math.exp(fit.c),
    predict: (ageYears: number, mileage: number) => Math.exp(fit!.a + fit!.b * ageYears + fit!.c * (mileage / 10_000)),
  }
}

export type Confidence = "high" | "medium" | "low"

export interface Valuation {
  readonly fairValue: number
  /** (fair − asking) / fair. Positive means the car is cheaper than the market. */
  readonly residualPct: number
  readonly selection: CompSelection
  readonly model: PriceModel
  /** 0–1. See confidenceOf() for why this exists. */
  readonly confidenceScore: number
  readonly confidence: Confidence
}

// Weights by how much a rung stretches the definition of "comparable".
const TIER_WEIGHT: Record<TierName, number> = {
  "generation+transmission": 1.0,
  generation: 0.95,
  "generation±3y": 0.85,
  series: 0.8,
  "series±3y": 0.7,
  "series±5y": 0.55,
}

/**
 * How much to trust one valuation.
 *
 * Leave-one-out over a live 490-listing VW corpus put the median absolute error
 * at 9.8%, but the spread is what matters: p25 3.5%, p75 23.6%, p90 45.8%. An
 * aggregate that good hiding a tail that bad means a single headline accuracy
 * number is not enough to act on — some of these estimates are near-worthless
 * and the agent has to know which.
 *
 * The three things that separate a solid estimate from a shaky one are all
 * knowable up front: how far the ladder had to widen, how many cars it found,
 * and how well the curve actually fits them. Notifications should be gated on
 * this, so a thin "series±5y" guess never wakes anyone up.
 */
export function confidenceOf(tier: TierName, n: number, r2: number): { score: number; band: Confidence } {
  const tierWeight = TIER_WEIGHT[tier]
  // 20+ comps is as good as it gets; HARD_MIN is barely worth having.
  const sampleWeight = Math.min(1, 0.3 + (0.7 * Math.max(0, n - HARD_MIN)) / (20 - HARD_MIN))
  // An r² below ~0.5 means age and mileage are not explaining this market.
  const fitWeight = Math.min(1, Math.max(0.2, (r2 - 0.3) / 0.55))

  const score = tierWeight * sampleWeight * fitWeight
  return { score, band: score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low" }
}

export type ValuationFailure = { readonly reason: "insufficient_comps" | "unstable_model"; readonly found: number; readonly selection?: CompSelection }

/**
 * Value one listing. Returns a failure rather than a guess when the evidence is
 * too thin — a made-up number here would propagate into a notification telling
 * the user to go and buy something.
 */
export function valueListing(store: Store, target: ValuationTarget, asking: number, currentYear = new Date().getFullYear()): Valuation | ValuationFailure {
  const selection = selectComps(store, target)
  if (!selection || selection.comps.length < HARD_MIN)
    return { reason: "insufficient_comps", found: selection?.comps.length ?? 0, selection }

  const model = fitPriceModel(selection.comps, currentYear)
  if (!model) return { reason: "unstable_model", found: selection.comps.length, selection }

  const fairValue = model.predict(currentYear - target.year, target.mileage)
  if (!Number.isFinite(fairValue) || fairValue <= 0) return { reason: "unstable_model", found: selection.comps.length, selection }

  const { score, band } = confidenceOf(selection.tier, model.n, model.r2)

  return {
    fairValue: Math.round(fairValue),
    residualPct: (fairValue - asking) / fairValue,
    selection,
    model,
    confidenceScore: score,
    confidence: band,
  }
}

export const isFailure = (result: Valuation | ValuationFailure): result is ValuationFailure => "reason" in result
