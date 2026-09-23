import { expect, test, describe, beforeEach } from "bun:test"
import { classifyListing, isMarketEvidence, isBuyable } from "../src/finn/listing-type.ts"
import { scoreListing } from "../src/value/score.ts"
import { Store } from "../src/store.ts"
import { parseSearchPage } from "../src/finn/search.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SearchEntry } from "../src/finn/types.ts"

describe("classifying what kind of ad this is", () => {
  test("the three shapes finn actually returns", () => {
    // Taken from live listings of the same Citroen E-C4: ad 476403489 was for
    // sale at 288 000 kr, ad 476537699 the same VIN leased at 3 789 kr/month.
    expect(classifyListing({ ad_type: 20, sales_form: 1 })).toBe("sale")
    expect(classifyListing({ ad_type: 200, sales_form: 5 })).toBe("lease")
    expect(classifyListing({ ad_type: 20, sales_form: 7 })).toBe("auction")
  })

  test("either lease signal alone is enough", () => {
    // Reading a monthly payment as a purchase price is the most damaging
    // mistake available, so this does not require both fields to agree.
    expect(classifyListing({ ad_type: 200 })).toBe("lease")
    expect(classifyListing({ sales_form: 5 })).toBe("lease")
  })

  test("an unrecognised combination is not assumed to be a sale", () => {
    expect(classifyListing({ ad_type: 22, sales_form: 2 })).toBe("other")
    expect(classifyListing({})).toBe("other")
  })

  test("only a real asking price counts as market evidence", () => {
    expect(isMarketEvidence("sale")).toBe(true)
    expect(isMarketEvidence("lease")).toBe(false)
    expect(isMarketEvidence("auction")).toBe(false) // a starting bid is not a sale price
    expect(isMarketEvidence("other")).toBe(false)
  })

  test("auctions are buyable, leases are not", () => {
    expect(isBuyable("auction")).toBe(true)
    expect(isBuyable("lease")).toBe(false)
  })
})

describe("keeping lease prices out of the valuation", () => {
  const realEntry = parseSearchPage(readFileSync(join(import.meta.dir, "fixtures", "search-car.html"), "utf8")).entries[0]!
  const car = (over: Partial<SearchEntry> & { ad_id: number }): SearchEntry => ({
    ...structuredClone(realEntry),
    make: "Citroen",
    series: "C4-Serie",
    model: "E-C4",
    fuel: "El",
    ad_type: 20,
    sales_form: 1,
    ...over,
  })

  let store: Store
  beforeEach(() => {
    store = new Store(":memory:")
  })

  test("a lease is never a comparable", () => {
    store.ingest([
      car({ ad_id: 1, year: 2025, mileage: 47000, price: { amount: 288000 } }),
      car({ ad_id: 2, year: 2025, mileage: 47000, price: { amount: 3789 }, ad_type: 200, sales_form: 5 }),
    ])
    const comps = store.comparables({ make: "Citroen", model: "E-C4", yearFrom: 2020, yearTo: 2026 })
    expect(comps.map((c) => c.ad_id)).toEqual([1])
  })

  test("nor is an auction starting bid", () => {
    store.ingest([
      car({ ad_id: 3, year: 2025, mileage: 47000, price: { amount: 288000 } }),
      car({ ad_id: 4, year: 2025, mileage: 47000, price: { amount: 2796 }, sales_form: 7 }),
    ])
    expect(store.comparables({ make: "Citroen", model: "E-C4", yearFrom: 2020, yearTo: 2026 }).map((c) => c.ad_id)).toEqual([3])
  })

  test("a lease never reaches the valuation queue at all", () => {
    store.ingest([car({ ad_id: 5, price: { amount: 3789 }, ad_type: 200, sales_form: 5 })])
    expect(store.valuationCandidates().map((c) => c.ad_id)).not.toContain(5)
  })

  test("the type is recorded so it survives a restart", () => {
    store.ingest([car({ ad_id: 6, ad_type: 200, sales_form: 5 })])
    expect((store.db.query("SELECT listing_type t FROM listings WHERE ad_id=6").get() as any).t).toBe("lease")
  })
})

describe("the same VIN for sale and to lease is not a relist", () => {
  const realEntry = parseSearchPage(readFileSync(join(import.meta.dir, "fixtures", "search-car.html"), "utf8")).entries[0]!
  const car = (over: Partial<SearchEntry> & { ad_id: number }): SearchEntry => ({
    ...structuredClone(realEntry),
    chassis_number: "VR7ABCDEFG1234567",
    ad_type: 20,
    sales_form: 1,
    ...over,
  })

  let store: Store
  beforeEach(() => {
    store = new Store(":memory:")
  })

  test("one car advertised two ways reports no relist", () => {
    // This invented a price drop from 288 000 kr to 3 789 kr on live data.
    store.ingest([car({ ad_id: 10, price: { amount: 288000 } })])
    const changes = store.ingest([car({ ad_id: 11, price: { amount: 3789 }, ad_type: 200, sales_form: 5 })])
    expect(changes.filter((c) => c.kind === "relisted")).toHaveLength(0)
  })

  test("but a genuine relist of the same sale listing is still caught", () => {
    store.ingest([car({ ad_id: 12, price: { amount: 288000 } })])
    const changes = store.ingest([car({ ad_id: 13, price: { amount: 269000 } })])
    expect(changes.filter((c) => c.kind === "relisted")).toHaveLength(1)
  })
})

describe("auction scoring", () => {
  const base = { residualPct: 0.3, confidence: "high" as const, year: 2018, mileage: 100_000, now: new Date("2026-09-23").getTime() }

  test("an auction cannot outrank a fixed price on the same residual", () => {
    // The price is a starting bid, so the residual overstates the deal.
    expect(scoreListing({ ...base, isAuction: true }).score).toBeLessThan(scoreListing(base).score)
  })

  test("and the reason is stated rather than silently applied", () => {
    expect(scoreListing({ ...base, isAuction: true }).parts.some((p) => p.label.includes("startbud"))).toBe(true)
  })
})
