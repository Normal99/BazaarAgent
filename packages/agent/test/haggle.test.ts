import { expect, test, describe } from "bun:test"
import { buildHagglePlan, type Lever } from "../src/value/haggle.ts"

const lever = (estValueNok: number, claim = "Rust"): Lever => ({ claim, evidence: "bilde", estValueNok, source: "bilde" })

const base = {
  asking: 150_000,
  fairValue: 160_000,
  confidence: "high" as const,
  levers: [] as Lever[],
  dealerSegment: "Privat",
}

describe("the over-budget case this exists for", () => {
  test("a car over budget but defensibly under it is flagged as haggleable", () => {
    // Asking 150k, market 150k, 8k of genuine defects → defensibly 142k, which
    // is under a 145k budget. The car is 5k over on the sticker and reachable.
    const plan = buildHagglePlan({ ...base, asking: 150_000, fairValue: 150_000, budget: 145_000, levers: [lever(8_000)] })

    expect(plan.overBudgetBy).toBe(5_000)
    expect(plan.defensibleValue).toBe(142_000)
    expect(plan.haggleableIntoBudget).toBe(true)
    expect(plan.plausible).toBe(true)
    expect(plan.target).toBeLessThanOrEqual(145_000)
    expect(plan.rationale.some((r) => r.includes("nok til å komme under"))).toBe(true)
  })

  test("defects that fall short of the budget gap are not called haggleable", () => {
    // Market 160k, asking 150k, only 12k of defects → defensibly 148k, still
    // above a 145k budget. Reporting this as reachable would send the user on
    // a wasted trip.
    const plan = buildHagglePlan({ ...base, budget: 145_000, levers: [lever(12_000)] })
    expect(plan.defensibleValue).toBe(148_000)
    expect(plan.haggleableIntoBudget).toBe(false)
  })

  test("says so plainly when the required discount is not defensible", () => {
    // 150k asking against a 110k budget needs 27% off; nothing supports that.
    const plan = buildHagglePlan({ ...base, budget: 110_000, levers: [lever(3_000)] })

    expect(plan.haggleableIntoBudget).toBe(false)
    expect(plan.plausible).toBe(false)
    expect(plan.requiredDiscountPct).toBeGreaterThan(plan.supportedDiscountPct)
    expect(plan.rationale.some((r) => r.includes("forsvarlig ut fra funnene"))).toBe(true)
  })

  test("a car already under budget is not an over-budget case", () => {
    const plan = buildHagglePlan({ ...base, budget: 200_000, levers: [lever(5_000)] })
    expect(plan.overBudgetBy).toBeUndefined()
    expect(plan.haggleableIntoBudget).toBe(false)
    expect(plan.plausible).toBe(true)
  })
})

describe("levers", () => {
  test("caps the total, because ten complaints do not add up to half the car", () => {
    const many = Array.from({ length: 10 }, () => lever(20_000)) // 200 000 kr of "defects"
    const plan = buildHagglePlan({ ...base, levers: many })

    expect(plan.leverTotal).toBeLessThan(200_000)
    expect(plan.leverTotal).toBeLessThanOrEqual(base.fairValue * 0.2)
    expect(plan.rationale.some((r) => r.includes("Begrenset fra"))).toBe(true)
  })

  test("allows a private seller more room than a dealer", () => {
    const levers = [lever(40_000)]
    const priv = buildHagglePlan({ ...base, levers, dealerSegment: "Privat" })
    const dealer = buildHagglePlan({ ...base, levers, dealerSegment: "Forhandler" })
    expect(priv.leverTotal).toBeGreaterThan(dealer.leverTotal)
  })

  test("a stale listing and prior price cuts widen what is realistic", () => {
    const levers = [lever(40_000)]
    const fresh = buildHagglePlan({ ...base, levers })
    const stale = buildHagglePlan({ ...base, levers, daysListed: 90, priceDrops: [160_000] })
    expect(stale.leverTotal).toBeGreaterThan(fresh.leverTotal)
  })
})

describe("targets", () => {
  test("never targets above the asking price", () => {
    // A car already priced far under market: the target is simply the asking price.
    const plan = buildHagglePlan({ ...base, asking: 100_000, fairValue: 160_000, levers: [] })
    expect(plan.target).toBe(100_000)
    expect(plan.walkAway).toBe(100_000)
    expect(plan.supportedDiscountPct).toBe(0)
  })

  test("walk-away sits above target but never above asking", () => {
    const plan = buildHagglePlan({ ...base, levers: [lever(20_000)] })
    expect(plan.walkAway).toBeGreaterThanOrEqual(plan.target)
    expect(plan.walkAway).toBeLessThanOrEqual(plan.asking)
  })
})

describe("re-registration fee", () => {
  test("derives the fee from finn's own figures rather than a rate table", () => {
    // finn reports price and "Pris eksl. omreg."; the fee is the difference.
    const plan = buildHagglePlan({ ...base, asking: 149_000, priceExclRegistration: 147_447 })
    expect(plan.omregFee).toBe(1_553)
    expect(plan.totalCost).toBe(150_553)
  })

  test("a veteran exempt from the fee shows no fee at all", () => {
    const plan = buildHagglePlan({ ...base, asking: 60_000, priceExclRegistration: undefined })
    expect(plan.omregFee).toBeUndefined()
    expect(plan.totalCost).toBe(60_000)
  })
})

describe("confidence", () => {
  test("a low-confidence valuation warns against using the number as an argument", () => {
    const plan = buildHagglePlan({ ...base, confidence: "low" })
    expect(plan.rationale.some((r) => r.includes("Usikkert verdianslag"))).toBe(true)
  })

  test("a high-confidence valuation adds no caveat", () => {
    const plan = buildHagglePlan({ ...base, confidence: "high" })
    expect(plan.rationale.some((r) => r.includes("Usikkert") || r.includes("Moderat"))).toBe(false)
  })
})
