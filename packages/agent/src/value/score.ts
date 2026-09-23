import type { Confidence } from "./comps.ts"

// One number, 0–10, for ranking a feed and for deciding what is worth waking
// someone up about.
//
// The residual against comparables carries most of the weight, because it is
// the only component measured against reality — high-confidence valuations run
// 2.7% median error. Everything else adjusts around it, and confidence scales
// the whole thing: a 20% bargain computed from six mismatched cars is not a
// bargain, it is noise, and the score has to say so.

export interface ScoreInput {
  /** (fair − asking) / fair. Positive means cheaper than the market. */
  readonly residualPct: number
  readonly confidence: Confidence
  readonly year: number
  readonly mileage: number
  readonly dealerSegment?: string | null
  /** Epoch ms when the ad was published. */
  readonly publishedAt?: number | null
  readonly priceDrops?: number
  readonly relisted?: boolean
  /** Total kroner of defects found by the analysis pass. */
  readonly leverTotal?: number
  readonly fairValue?: number
  /** Registry disagreements with the ad — these weigh heavily. */
  readonly registryFindings?: number
  readonly now?: number
}

export interface ScoreBreakdown {
  readonly score: number
  /** Each contribution, for a UI that explains itself instead of asserting. */
  readonly parts: Array<{ label: string; delta: number }>
}

const CONFIDENCE_SCALE: Record<Confidence, number> = { high: 1, medium: 0.75, low: 0.4 }

/** Past this, a bargain stops being plausible and starts being a warning. */
export const SUSPICION_THRESHOLD = 0.35

/**
 * Phrases that mean the listing is not a car you can drive away.
 *
 * Cheap, deterministic, and it runs before the LLM rather than after, because a
 * parts car should never reach the top of a feed in the first place. The
 * keyword list is Norwegian for the obvious reason: these are the exact phrases
 * sellers use.
 */
const NOT_A_RUNNER = [
  /selges?\s+i\s+deler/i,
  /\bdelebil\b/i,
  /til\s+deler\b/i,
  /\bkondemnert\b/i,
  /ikke\s+kj[øo]rbar/i,
  /motorhavari/i,
  /\bvrak\b/i,
  /defekt\s+motor/i,
  /starter\s+ikke/i,
  /uten\s+motor/i,
  // Found by the LLM pass on a live listing the keyword list had missed.
  /reparasjonsobjekt/i,
  /bruksskadet/i,
]

/**
 * Whether an odometer read off a photo is worth raising with a seller.
 *
 * Measured, and the reason this gate exists: on a 2020 Peugeot Partner the
 * dashboard reads 038783 km, and the model reported 39183 — right to within
 * about 1%, but with two digits transposed. The ad text ("Kun 38 800 km") in
 * fact agreed with the photo; only the spec table was stale.
 *
 * Digit-level OCR of a photographed instrument cluster is not reliable enough
 * to quote. A small difference is far more likely to be a misread than a
 * tampered odometer, and walking up to a seller with a number their dashboard
 * does not show loses the argument outright. So only a difference too large to
 * be a misreading is reported, and even then as something to verify rather
 * than as an established fact.
 */
export function odometerDiscrepancy(
  seenKm: number | null | undefined,
  statedKm: number | undefined,
): { material: boolean; deltaKm?: number; note?: string } {
  if (seenKm == null || statedKm == null) return { material: false }
  const delta = Math.abs(seenKm - statedKm)
  const relative = statedKm > 0 ? delta / statedKm : 0
  // Both thresholds must be cleared: 5 000 km on a 300 000 km car is noise,
  // and 5% of a 20 000 km car is a rounding difference.
  if (delta < 5_000 || relative < 0.05) return { material: false, deltaKm: delta }
  return {
    material: true,
    deltaKm: delta,
    note: `Instrumentbildet ser ut til å vise ca. ${seenKm.toLocaleString("nb-NO")} km mot ${statedKm.toLocaleString("nb-NO")} km oppgitt — sjekk selv mot bildet før du tar det opp.`,
  }
}

/** Whether an ad describes something other than a working car. */
export function looksLikePartsCar(description: string | null | undefined): { hit: boolean; phrase?: string } {
  if (!description) return { hit: false }
  for (const pattern of NOT_A_RUNNER) {
    const match = pattern.exec(description)
    if (match) return { hit: true, phrase: match[0] }
  }
  return { hit: false }
}

export function scoreListing(input: ScoreInput): ScoreBreakdown {
  const parts: Array<{ label: string; delta: number }> = []
  const now = input.now ?? Date.now()

  // Residual is the backbone, but it is not monotonic and treating it as such
  // is wrong. A car 20% under market is a find; a car 95% under market is a
  // parts car, a wreck or a mis-listing. A live sweep put a 2017 Peugeot
  // Partner at 4 553 kr top of the feed on a 95% residual — the ad read
  // "bilen selges i deler". The curve therefore peaks at a plausible bargain
  // and falls away beyond it, because past that point a large residual is
  // evidence of a problem rather than of value.
  const residual = Math.max(-0.25, Math.min(0.25, input.residualPct))
  const base = 5 + (residual / 0.25) * 4
  parts.push({ label: residual >= 0 ? `${(residual * 100).toFixed(0)}% under marked` : `${(-residual * 100).toFixed(0)}% over marked`, delta: base - 5 })

  let score = base

  if (input.residualPct > SUSPICION_THRESHOLD) {
    // Scale the penalty with how implausible it is: 40% under is worth a
    // second look, 90% under is almost never a car you can drive away.
    const excess = (input.residualPct - SUSPICION_THRESHOLD) / (1 - SUSPICION_THRESHOLD)
    const delta = -Math.min(6, 2 + excess * 6)
    parts.push({ label: `${(input.residualPct * 100).toFixed(0)}% under marked — for godt til å stemme`, delta })
    score += delta
  }

  // Mileage against what is normal for the age. Norwegian average is roughly
  // 12 000 km/yr; well under that is worth something, well over costs.
  const age = Math.max(1, new Date(now).getFullYear() - input.year)
  const kmPerYear = input.mileage / age
  if (kmPerYear < 9_000) {
    parts.push({ label: `lav bruk (${Math.round(kmPerYear / 1000)}k km/år)`, delta: 0.5 })
    score += 0.5
  } else if (kmPerYear > 20_000) {
    parts.push({ label: `høy bruk (${Math.round(kmPerYear / 1000)}k km/år)`, delta: -0.6 })
    score -= 0.6
  }

  // A private seller is where the negotiating room is.
  if ((input.dealerSegment ?? "").toLowerCase().startsWith("privat")) {
    parts.push({ label: "privatselger", delta: 0.3 })
    score += 0.3
  }

  // Time on the market and prior cuts: both say the seller is getting tired.
  const days = input.publishedAt ? Math.floor((now - input.publishedAt) / 86_400_000) : 0
  if (days > 45) {
    parts.push({ label: `${days} dager på markedet`, delta: 0.4 })
    score += 0.4
  }
  if ((input.priceDrops ?? 0) > 0) {
    const delta = Math.min(0.6, 0.3 * input.priceDrops!)
    parts.push({ label: `${input.priceDrops} prisnedgang${input.priceDrops! > 1 ? "er" : ""}`, delta })
    score += delta
  }
  if (input.relisted) {
    parts.push({ label: "lagt ut på nytt (solgte ikke)", delta: 0.7 })
    score += 0.7
  }

  // Defects found. These are already reflected in the haggle target, but a car
  // needing 30 000 kr of work is a worse buy than the residual alone suggests.
  if (input.leverTotal && input.fairValue) {
    const share = input.leverTotal / input.fairValue
    const delta = -Math.min(2, share * 8)
    parts.push({ label: `funn verdt ${Math.round(input.leverTotal).toLocaleString("nb-NO")} kr`, delta })
    score += delta
  }

  // The registry contradicting the ad is the single worst signal available,
  // because it means the seller's account is unreliable, not merely incomplete.
  if (input.registryFindings) {
    const delta = -1.5 * input.registryFindings
    parts.push({ label: "register motsier annonsen", delta })
    score += delta
  }

  // Confidence scales the distance from neutral rather than the score itself,
  // so an unreliable valuation is pulled towards 5 from either direction
  // instead of being quietly rewarded for being uncertain.
  const scale = CONFIDENCE_SCALE[input.confidence]
  const scaled = 5 + (score - 5) * scale
  if (scale < 1) parts.push({ label: `${input.confidence} sikkerhet`, delta: scaled - score })

  return { score: Math.max(0, Math.min(10, Number(scaled.toFixed(2)))), parts }
}
