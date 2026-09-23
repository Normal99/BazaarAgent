import { expect, test, describe, beforeEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Store } from "../src/store.ts"
import { parseSearchPage } from "../src/finn/search.ts"
import { selectComps, fitPriceModel, valueListing, isFailure, confidenceOf, HARD_MIN } from "../src/value/comps.ts"
import type { SearchEntry } from "../src/finn/types.ts"

const realEntry = parseSearchPage(readFileSync(join(import.meta.dir, "fixtures", "search-car.html"), "utf8")).entries[0]!

let store: Store
beforeEach(() => {
  store = new Store(":memory:")
})

const car = (over: Partial<SearchEntry> & { ad_id: number }): SearchEntry => ({
  ...structuredClone(realEntry),
  make: "Volkswagen",
  series: "Golf-Serie",
  model: "Golf VII",
  fuel: "Bensin",
  transmission: "Manuell",
  ...over,
})

/** A market where price = base · 0.88^age · 0.97^(km/10k), plus a little noise. */
function syntheticMarket(count: number, opts: { base?: number; model?: string; fuel?: string } = {}) {
  const base = opts.base ?? 400_000
  const cars: SearchEntry[] = []
  for (let i = 0; i < count; i++) {
    const year = 2014 + (i % 8)
    const age = 2026 - year
    const mileage = 40_000 + (i % 10) * 20_000
    const noise = 1 + ((i % 5) - 2) * 0.015
    cars.push(
      car({
        ad_id: 1000 + i,
        year,
        mileage,
        fuel: opts.fuel ?? "Bensin",
        model: opts.model ?? "Golf VII",
        price: { amount: Math.round(base * 0.88 ** age * 0.97 ** (mileage / 10_000) * noise) },
      }),
    )
  }
  return cars
}

describe("comp selection ladder", () => {
  test("stays on the narrow rung when the generation alone has enough cars", () => {
    store.ingest(syntheticMarket(12))
    const selection = selectComps(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2017, mileage: 100_000, fuel: "Bensin", transmission: "Manuell" })
    expect(selection!.tier).toBe("generation+transmission")
    expect(selection!.comps.length).toBeGreaterThanOrEqual(8)
  })

  test("widens to series when the generation is too thin", () => {
    // Four Golf VII, but plenty of Golf VI in the same series.
    store.ingest([
      ...syntheticMarket(4),
      ...syntheticMarket(10, { model: "Golf VI" }).map((c, i) => ({ ...c, ad_id: 2000 + i })),
    ])
    const selection = selectComps(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2017, mileage: 100_000, fuel: "Bensin", transmission: "Manuell" })
    expect(selection!.tier).toMatch(/^series/)
    expect(selection!.comps.length).toBeGreaterThanOrEqual(8)
  })

  test("never widens across fuel, so an e-Golf market cannot value a petrol Golf", () => {
    store.ingest([
      ...syntheticMarket(3),
      ...syntheticMarket(20, { model: "e-Golf VII", fuel: "Elektrisitet", base: 300_000 }).map((c, i) => ({ ...c, ad_id: 3000 + i })),
    ])
    const selection = selectComps(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2017, mileage: 100_000, fuel: "Bensin", transmission: "Manuell" })
    expect(selection!.comps.every((c) => c.fuel === "Bensin")).toBe(true)
    expect(selection!.comps.length).toBe(3) // thin, and correctly so
  })

  test("a model with no series (ID.3, Amarok) still matches on generation", () => {
    store.ingest(syntheticMarket(10).map((c) => ({ ...c, series: undefined, model: "ID.3" })))
    const selection = selectComps(store, { make: "Volkswagen", model: "ID.3", series: null, year: 2017, mileage: 100_000, fuel: "Bensin" })
    expect(selection!.comps.length).toBeGreaterThanOrEqual(8)
  })

  test("excludes the car being valued from its own comparables", () => {
    store.ingest(syntheticMarket(12))
    const selection = selectComps(store, { adId: 1000, make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2017, mileage: 100_000, fuel: "Bensin" })
    expect(selection!.comps.map((c) => c.ad_id)).not.toContain(1000)
  })
})

describe("price model", () => {
  test("recovers the depreciation it was generated with", () => {
    store.ingest(syntheticMarket(40))
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2010, yearTo: 2026 })
    const model = fitPriceModel(comps, 2026)!

    expect(model.perYear).toBeCloseTo(0.12, 1) // 0.88^age → 12%/yr
    expect(model.per10kKm).toBeCloseTo(0.03, 1) // 0.97^(km/10k) → 3%/10k km
    expect(model.r2).toBeGreaterThan(0.9)
  })

  test("a parts car at 3 299 kr does not drag the curve down", () => {
    // Exactly the junk the live sweep turned up in a normal search.
    store.ingest([...syntheticMarket(20), car({ ad_id: 9999, year: 2018, mileage: 120_000, price: { amount: 3_299 } })])
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2010, yearTo: 2026 })

    const model = fitPriceModel(comps, 2026)!
    expect(model.dropped).toBeGreaterThanOrEqual(1)

    const clean = fitPriceModel(comps.filter((c) => c.ad_id !== 9999), 2026)!
    // The trimmed fit should land close to the fit that never saw the outlier.
    expect(model.predict(9, 100_000)).toBeCloseTo(clean.predict(9, 100_000), -4)
  })

  test("refuses to fit when every comp is the same year and mileage", () => {
    store.ingest(Array.from({ length: 10 }, (_, i) => car({ ad_id: 500 + i, year: 2018, mileage: 100_000, price: { amount: 200_000 } })))
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2010, yearTo: 2026 })
    expect(fitPriceModel(comps, 2026)).toBeUndefined()
  })

  test("refuses to fit below the hard minimum", () => {
    store.ingest(syntheticMarket(HARD_MIN - 1))
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2010, yearTo: 2026 })
    expect(fitPriceModel(comps, 2026)).toBeUndefined()
  })
})

describe("valuation", () => {
  test("prices a car near the market it came from", () => {
    store.ingest(syntheticMarket(40))
    // 2018, 100 000 km in that market ≈ 400k · 0.88^8 · 0.97^10
    const expected = 400_000 * 0.88 ** 8 * 0.97 ** 10
    const result = valueListing(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2018, mileage: 100_000, fuel: "Bensin", transmission: "Manuell" }, Math.round(expected), 2026)

    expect(isFailure(result)).toBe(false)
    if (isFailure(result)) return
    expect(result.fairValue).toBeCloseTo(expected, -4)
    expect(Math.abs(result.residualPct)).toBeLessThan(0.08)
  })

  test("a car priced well under its market shows a positive residual", () => {
    store.ingest(syntheticMarket(40))
    const fair = 400_000 * 0.88 ** 8 * 0.97 ** 10
    const result = valueListing(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2018, mileage: 100_000, fuel: "Bensin" }, Math.round(fair * 0.8), 2026)

    if (isFailure(result)) throw new Error("expected a valuation")
    expect(result.residualPct).toBeGreaterThan(0.15)
  })

  test("a wide, thin, badly-fitting comp set is marked low confidence", () => {
    // Measured on live data: low-confidence valuations run 16.9% median error
    // against 2.7% for high, so this banding is what keeps a bad estimate from
    // firing a notification.
    expect(confidenceOf("generation+transmission", 30, 0.95).band).toBe("high")
    expect(confidenceOf("series±5y", 6, 0.4).band).toBe("low")
    expect(confidenceOf("generation+transmission", 30, 0.95).score).toBeGreaterThan(confidenceOf("series±5y", 30, 0.95).score)
  })

  test("confidence falls when any one of tier, sample size or fit degrades", () => {
    const base = confidenceOf("generation", 20, 0.9).score
    expect(confidenceOf("series±3y", 20, 0.9).score).toBeLessThan(base) // wider tier
    expect(confidenceOf("generation", 6, 0.9).score).toBeLessThan(base) // fewer comps
    expect(confidenceOf("generation", 20, 0.4).score).toBeLessThan(base) // worse fit
  })

  test("a valuation carries its confidence", () => {
    store.ingest(syntheticMarket(40))
    const result = valueListing(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2018, mileage: 100_000, fuel: "Bensin", transmission: "Manuell" }, 200_000, 2026)
    if (isFailure(result)) throw new Error("expected a valuation")
    expect(result.confidence).toBe("high")
    expect(result.confidenceScore).toBeGreaterThan(0.7)
  })

  test("refuses to value rather than guessing when comps are too thin", () => {
    store.ingest(syntheticMarket(3))
    const result = valueListing(store, { make: "Volkswagen", model: "Golf VII", series: "Golf-Serie", year: 2018, mileage: 100_000, fuel: "Bensin" }, 200_000, 2026)

    expect(isFailure(result)).toBe(true)
    if (!isFailure(result)) return
    expect(result.reason).toBe("insufficient_comps")
    expect(result.found).toBeLessThan(HARD_MIN)
  })
})
