import { expect, test, describe } from "bun:test"
import { scoreListing, looksLikePartsCar, SUSPICION_THRESHOLD } from "../src/value/score.ts"

const base = { residualPct: 0.1, confidence: "high" as const, year: 2018, mileage: 100_000, now: new Date("2026-09-23").getTime() }

describe("residual scoring", () => {
  test("a plausible bargain scores well", () => {
    expect(scoreListing({ ...base, residualPct: 0.2 }).score).toBeGreaterThan(7.5)
  })

  test("an implausible bargain is penalised, not rewarded", () => {
    // Measured live: a 2017 Peugeot Partner at 4 553 kr topped the feed on a
    // 95% residual. The ad read "bilen selges i deler".
    const plausible = scoreListing({ ...base, residualPct: 0.2 }).score
    const absurd = scoreListing({ ...base, residualPct: 0.95 }).score
    expect(absurd).toBeLessThan(plausible)
    expect(scoreListing({ ...base, residualPct: 0.95 }).parts.some((p) => p.label.includes("for godt"))).toBe(true)
  })

  test("the penalty scales with how implausible the price is", () => {
    const mild = scoreListing({ ...base, residualPct: SUSPICION_THRESHOLD + 0.1 }).score
    const wild = scoreListing({ ...base, residualPct: 0.9 }).score
    expect(wild).toBeLessThan(mild)
  })

  test("a car priced over market scores below neutral", () => {
    expect(scoreListing({ ...base, residualPct: -0.2 }).score).toBeLessThan(5)
  })
})

describe("confidence scaling", () => {
  test("an uncertain valuation is pulled towards neutral from either side", () => {
    const goodHigh = scoreListing({ ...base, residualPct: 0.2, confidence: "high" }).score
    const goodLow = scoreListing({ ...base, residualPct: 0.2, confidence: "low" }).score
    const badHigh = scoreListing({ ...base, residualPct: -0.2, confidence: "high" }).score
    const badLow = scoreListing({ ...base, residualPct: -0.2, confidence: "low" }).score
    expect(goodLow).toBeLessThan(goodHigh)
    expect(badLow).toBeGreaterThan(badHigh) // pulled UP towards neutral, not rewarded
  })
})

describe("signals", () => {
  test("relisting, price cuts and a stale ad all help the buyer", () => {
    const plain = scoreListing(base).score
    expect(scoreListing({ ...base, relisted: true }).score).toBeGreaterThan(plain)
    expect(scoreListing({ ...base, priceDrops: 2 }).score).toBeGreaterThan(plain)
    expect(scoreListing({ ...base, publishedAt: base.now - 60 * 86_400_000 }).score).toBeGreaterThan(plain)
  })

  test("the registry contradicting the ad is the heaviest negative", () => {
    expect(scoreListing({ ...base, registryFindings: 1 }).score).toBeLessThan(base.residualPct > 0 ? scoreListing(base).score : 10)
  })

  test("expensive defects lower the score even at the same asking price", () => {
    const clean = scoreListing(base).score
    const needy = scoreListing({ ...base, leverTotal: 30_000, fairValue: 150_000 }).score
    expect(needy).toBeLessThan(clean)
  })
})

describe("parts-car detection", () => {
  test("catches the phrases sellers actually use", () => {
    expect(looksLikePartsCar("Hei bilen selges i deler ring 92850937").hit).toBe(true)
    expect(looksLikePartsCar("Delebil, mye bra igjen").hit).toBe(true)
    expect(looksLikePartsCar("Motorhavari, selges billig").hit).toBe(true)
    expect(looksLikePartsCar("Bilen starter ikke").hit).toBe(true)
  })

  test("does not fire on an ordinary ad", () => {
    expect(looksLikePartsCar("Pen bil, nye dekk og fersk EU. Selges da vi har kjøpt større.").hit).toBe(false)
    expect(looksLikePartsCar("Alle deler er originale").hit).toBe(false)
    expect(looksLikePartsCar(null).hit).toBe(false)
  })

  test("reports the phrase it matched so the reason is auditable", () => {
    expect(looksLikePartsCar("bilen selges i deler").phrase).toMatch(/selges i deler/i)
  })
})

describe("odometer readings from photos", () => {
  test("ignores a small difference, which is far more likely a misread", () => {
    // Live case: dashboard shows 038783, model reported 39183 — two digits
    // transposed. Quoting that to a seller loses the argument.
    const { odometerDiscrepancy } = require("../src/value/score.ts")
    expect(odometerDiscrepancy(39_183, 39_500).material).toBe(false)
    expect(odometerDiscrepancy(38_783, 38_800).material).toBe(false)
  })

  test("reports a difference too large to be a misreading", () => {
    const { odometerDiscrepancy } = require("../src/value/score.ts")
    const result = odometerDiscrepancy(95_000, 180_000)
    expect(result.material).toBe(true)
    expect(result.deltaKm).toBe(85_000)
    expect(result.note).toContain("sjekk selv")
  })

  test("needs both an absolute and a relative gap", () => {
    const { odometerDiscrepancy } = require("../src/value/score.ts")
    // 6 000 km on a 300 000 km car is 2% — noise.
    expect(odometerDiscrepancy(294_000, 300_000).material).toBe(false)
    // 10% of a 20 000 km car is only 2 000 km — still within misread range.
    expect(odometerDiscrepancy(18_000, 20_000).material).toBe(false)
  })

  test("says nothing when there is no reading", () => {
    const { odometerDiscrepancy } = require("../src/value/score.ts")
    expect(odometerDiscrepancy(null, 100_000).material).toBe(false)
    expect(odometerDiscrepancy(100_000, undefined).material).toBe(false)
  })
})
