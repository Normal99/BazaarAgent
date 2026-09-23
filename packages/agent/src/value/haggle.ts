import type { Confidence } from "./comps.ts"

// Turning a valuation into a number you can say out loud.
//
// The case this exists for: a car priced slightly above budget is not a car to
// discard. If the asking price is over budget but the *defensible* price is
// under it, that is the most interesting listing on the page — a deal you can
// talk your way into. Everything here is arranged to answer that question
// honestly, including when the answer is no.

export interface Lever {
  readonly claim: string
  readonly evidence: string
  readonly estValueNok: number
  readonly source: "tekst" | "bilde" | "register" | "marked"
}

export interface HaggleInput {
  readonly asking: number
  /** From finn's "Pris eksl. omreg." — the fee is the difference, not a table lookup. */
  readonly priceExclRegistration?: number
  readonly fairValue: number
  readonly confidence: Confidence
  readonly levers: readonly Lever[]
  readonly budget?: number
  /** Private sellers move on price more readily than dealers. */
  readonly dealerSegment?: string
  /** Days the ad has been up — patience is leverage. */
  readonly daysListed?: number
  /** Earlier price cuts, newest last. */
  readonly priceDrops?: readonly number[]
}

export interface HagglePlan {
  readonly asking: number
  readonly omregFee?: number
  /** What leaves your account: asking plus re-registration where it applies. */
  readonly totalCost: number
  readonly fairValue: number
  /** Fair value less what is actually wrong with this specific car. */
  readonly defensibleValue: number
  readonly levers: readonly Lever[]
  readonly leverTotal: number
  /** What to aim for. */
  readonly target: number
  /** Above this you are overpaying for this particular car. */
  readonly walkAway: number
  readonly budget?: number
  readonly overBudgetBy?: number
  /** Over budget on the sticker, but defensibly under it. The headline case. */
  readonly haggleableIntoBudget: boolean
  /** Discount needed to reach budget, as a fraction of asking. */
  readonly requiredDiscountPct?: number
  /** Discount the evidence actually supports. */
  readonly supportedDiscountPct: number
  /** Whether the required discount is within what the evidence supports. */
  readonly plausible: boolean
  readonly rationale: string[]
}

/**
 * How much of a discount is realistic before the argument stops landing.
 *
 * A private seller who has held a car for two months will move further than a
 * dealer on week one. These are deliberately conservative: the cost of an
 * over-optimistic target is a wasted trip and a seller who stops replying.
 */
function realisticCeiling(input: HaggleInput): number {
  const isPrivate = (input.dealerSegment ?? "").toLowerCase().startsWith("privat")
  let ceiling = isPrivate ? 0.1 : 0.06
  if ((input.daysListed ?? 0) > 60) ceiling += 0.04
  else if ((input.daysListed ?? 0) > 30) ceiling += 0.02
  // Already cutting the price signals a seller working towards their floor.
  if ((input.priceDrops?.length ?? 0) > 0) ceiling += 0.03
  return Math.min(ceiling, 0.2)
}

export function buildHagglePlan(input: HaggleInput): HagglePlan {
  const { asking, fairValue, budget } = input

  const omregFee =
    input.priceExclRegistration !== undefined && input.priceExclRegistration > 0 && input.priceExclRegistration < asking
      ? asking - input.priceExclRegistration
      : undefined
  const totalCost = asking + (omregFee ?? 0)

  // Levers are capped rather than summed freely: ten small complaints do not
  // add up to half the car, and presenting them as though they do gets you
  // dismissed rather than a discount.
  const rawLeverTotal = input.levers.reduce((sum, lever) => sum + Math.max(0, lever.estValueNok), 0)
  const leverCap = fairValue * realisticCeiling(input)
  const leverTotal = Math.min(rawLeverTotal, leverCap)

  const defensibleValue = Math.max(0, fairValue - leverTotal)
  // No sense targeting above the asking price — a car already priced under its
  // defensible value is simply cheap, and the target is what it says.
  const target = Math.round(Math.min(defensibleValue, asking))
  // A few percent of tolerance: meeting in the middle is still a good outcome.
  const walkAway = Math.round(Math.min(asking, defensibleValue * 1.03))

  const supportedDiscountPct = asking > 0 ? (asking - target) / asking : 0
  const overBudgetBy = budget !== undefined && asking > budget ? asking - budget : undefined
  const requiredDiscountPct = budget !== undefined && asking > budget ? (asking - budget) / asking : undefined
  const haggleableIntoBudget = budget !== undefined && asking > budget && target <= budget
  const plausible = requiredDiscountPct === undefined ? true : requiredDiscountPct <= supportedDiscountPct

  const rationale: string[] = []
  rationale.push(`Markedsverdi for en tilsvarende bil: ${kr(fairValue)}.`)
  if (asking > fairValue) rationale.push(`Prisantydning ligger ${kr(asking - fairValue)} over markedet.`)
  else rationale.push(`Prisantydning ligger ${kr(fairValue - asking)} under markedet.`)

  if (input.levers.length > 0) {
    rationale.push(`Konkrete forhold som trekker ned (${kr(leverTotal)} totalt):`)
    for (const lever of [...input.levers].sort((a, b) => b.estValueNok - a.estValueNok).slice(0, 6))
      rationale.push(`  · ${lever.claim} — ${kr(lever.estValueNok)} (${lever.evidence})`)
    if (rawLeverTotal > leverCap)
      rationale.push(`  (Begrenset fra ${kr(rawLeverTotal)}: mer enn ~${Math.round(realisticCeiling(input) * 100)} % avslag er sjelden realistisk her.)`)
  }

  if (overBudgetBy !== undefined) {
    rationale.push(
      haggleableIntoBudget
        ? `Bilen ligger ${kr(overBudgetBy)} over budsjett, men ${kr(asking - target)} avslag er forsvarlig — det er nok til å komme under.`
        : `Bilen ligger ${kr(overBudgetBy)} over budsjett. Du må ha ${pct(requiredDiscountPct!)} avslag, men bare ${pct(supportedDiscountPct)} er forsvarlig ut fra funnene.`,
    )
  }

  if (input.confidence !== "high")
    rationale.push(
      input.confidence === "low"
        ? "Usikkert verdianslag — for få eller for ulike sammenligningsbiler. Bruk tallet som en pekepinn, ikke et argument."
        : "Moderat sikkert verdianslag.",
    )

  return {
    asking,
    omregFee,
    totalCost,
    fairValue: Math.round(fairValue),
    defensibleValue: Math.round(defensibleValue),
    levers: input.levers,
    leverTotal: Math.round(leverTotal),
    target,
    walkAway,
    budget,
    overBudgetBy,
    haggleableIntoBudget,
    requiredDiscountPct,
    supportedDiscountPct,
    plausible,
    rationale,
  }
}

const kr = (n: number) => `${Math.round(n).toLocaleString("nb-NO")} kr`
const pct = (n: number) => `${(n * 100).toFixed(1)} %`
