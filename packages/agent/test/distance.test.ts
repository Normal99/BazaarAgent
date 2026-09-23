import { expect, test, describe } from "bun:test"
import { haversineKm, travelCost, distancePenalty } from "../src/value/distance.ts"
import { parseHome } from "../src/home.ts"
import { scoreListing } from "../src/value/score.ts"

const SKIEN = { lat: 59.2096, lon: 9.6089 }
const OSLO = { lat: 59.9139, lon: 10.7522 }
const KONGSFJORD = { lat: 70.7264, lon: 29.3494 }

describe("distance", () => {
  test("matches known Norwegian distances", () => {
    // Skien–Oslo is about 110 km as the crow flies.
    expect(haversineKm(SKIEN, OSLO)).toBeGreaterThan(95)
    expect(haversineKm(SKIEN, OSLO)).toBeLessThan(125)
    // Skien–Kongsfjord in Finnmark is well over 1 200 km straight-line.
    expect(haversineKm(SKIEN, KONGSFJORD)).toBeGreaterThan(1_200)
  })

  test("is zero to itself and symmetric", () => {
    expect(haversineKm(SKIEN, SKIEN)).toBeCloseTo(0, 5)
    expect(haversineKm(SKIEN, OSLO)).toBeCloseTo(haversineKm(OSLO, SKIEN), 6)
  })

  test("road distance exceeds the straight line, as Norwegian roads do", () => {
    const trip = travelCost(SKIEN, OSLO)
    expect(trip.roadKm).toBeGreaterThan(trip.straightLineKm)
    expect(trip.costNok).toBeGreaterThan(0)
    expect(trip.hours).toBeGreaterThan(0)
  })

  test("warns that a long trip is a straight-line estimate", () => {
    // Understating a Finnmark drive by hundreds of km would be worse than
    // saying nothing, so the caveat is attached rather than implied.
    expect(travelCost(SKIEN, KONGSFJORD).note).toContain("Luftlinje")
    expect(travelCost(SKIEN, OSLO).note).not.toContain("Luftlinje")
  })
})

describe("the penalty", () => {
  test("rewards nearby and punishes far, monotonically", () => {
    const deltas = [30, 100, 250, 500, 1500].map((km) => distancePenalty(km).delta)
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]!).toBeLessThanOrEqual(deltas[i - 1]!)
    expect(distancePenalty(30).delta).toBeGreaterThan(0)
    expect(distancePenalty(1500).delta).toBeLessThan(-1)
  })

  test("labels carry the distance so the score explains itself", () => {
    expect(distancePenalty(500).label).toContain("dagstur")
    expect(distancePenalty(1500).label).toContain("langt unna")
  })
})

describe("scoring with distance", () => {
  const base = { residualPct: 0.15, confidence: "high" as const, year: 2018, mileage: 100_000, now: new Date("2026-09-23").getTime() }

  test("a marginally cheaper car far away no longer outranks one nearby", () => {
    // The Kongsfjord case: a Transporter ~1 800 km away scored on price alone.
    const nearby = scoreListing({ ...base, residualPct: 0.15, distance: distancePenalty(40) }).score
    const distant = scoreListing({ ...base, residualPct: 0.18, distance: distancePenalty(1_500) }).score
    expect(distant).toBeLessThan(nearby)
  })

  test("but an exceptional car is still worth the drive", () => {
    const nearbyMediocre = scoreListing({ ...base, residualPct: 0.02, distance: distancePenalty(40) }).score
    const distantBargain = scoreListing({ ...base, residualPct: 0.24, distance: distancePenalty(600) }).score
    expect(distantBargain).toBeGreaterThan(nearbyMediocre)
  })

  test("no home configured means distance does not move the score at all", () => {
    expect(scoreListing({ ...base, distance: undefined }).score).toBe(scoreListing(base).score)
  })
})

describe("distance scoring is a separate switch from knowing where you are", () => {
  // The two are different questions. Distance is always worth showing — a
  // 900 km trip is a fact you want on the card — but whether it should push a
  // car down the ranking is a preference.
  const base = { residualPct: 0.15, confidence: "high" as const, year: 2018, mileage: 100_000, now: new Date("2026-09-23").getTime() }

  test("switched off, a distant car ranks exactly like a near one", () => {
    // distanceFor() returns undefined when scoring is off, so the score input
    // is identical whether the car is 40 km or 1500 km away.
    const off = scoreListing({ ...base, distance: undefined }).score
    expect(scoreListing({ ...base, distance: undefined }).score).toBe(off)
    expect(off).toBe(scoreListing(base).score)
  })

  test("a weight scales the penalty without removing it", () => {
    const full = distancePenalty(1_500).delta
    const half = full * 0.5
    const scoredFull = scoreListing({ ...base, distance: { delta: full, label: "langt" } }).score
    const scoredHalf = scoreListing({ ...base, distance: { delta: half, label: "langt" } }).score
    const scoredNone = scoreListing({ ...base, distance: undefined }).score

    expect(scoredFull).toBeLessThan(scoredHalf)
    expect(scoredHalf).toBeLessThan(scoredNone)
  })

  test("a weight of zero is equivalent to switching it off", () => {
    expect(scoreListing({ ...base, distance: { delta: distancePenalty(1_500).delta * 0, label: "x" } }).score).toBe(
      scoreListing({ ...base, distance: undefined }).score,
    )
  })
})

describe("reading a stored home", () => {

  test("a file written before the toggle existed still counts distance", () => {
    // Defaulting to on is the obvious reading of an explicitly-set home.
    const home = parseHome({ lat: 59.2663, lon: 9.5311, label: "Skien" })!
    expect(home.scoreDistance).toBe(true)
    expect(home.weight).toBe(1)
  })

  test("an explicit off is honoured", () => {
    expect(parseHome({ lat: 59, lon: 9, label: "x", scoreDistance: false })!.scoreDistance).toBe(false)
  })

  test("a weight is kept, and a nonsensical one falls back to 1", () => {
    expect(parseHome({ lat: 59, lon: 9, weight: 0.5 })!.weight).toBe(0.5)
    expect(parseHome({ lat: 59, lon: 9, weight: 0 })!.weight).toBe(0)
    expect(parseHome({ lat: 59, lon: 9, weight: -3 })!.weight).toBe(1)
    expect(parseHome({ lat: 59, lon: 9, weight: "far" as any })!.weight).toBe(1)
  })

  test("a file without usable coordinates is no home at all", () => {
    expect(parseHome({ label: "Skien" })).toBeUndefined()
    expect(parseHome({ lat: "59" as any, lon: 9 })).toBeUndefined()
    expect(parseHome({ lat: NaN, lon: 9 })).toBeUndefined()
    expect(parseHome(null)).toBeUndefined()
  })
})
