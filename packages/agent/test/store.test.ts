import { expect, test, describe, beforeEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Store } from "../src/store.ts"
import { parseSearchPage } from "../src/finn/search.ts"
import type { SearchEntry } from "../src/finn/types.ts"

const realEntries = parseSearchPage(readFileSync(join(import.meta.dir, "fixtures", "search-car.html"), "utf8")).entries

let store: Store
beforeEach(() => {
  store = new Store(":memory:")
})

/** A real finn entry with specific fields overridden. */
// The captured fixture is an AUCTION (sales_form 7), so helpers say plainly
// that they mean an ordinary sale — otherwise every one of these would be
// excluded from the comparables, correctly but confusingly.
const entry = (over: Partial<SearchEntry> = {}): SearchEntry => ({
  ...structuredClone(realEntries[0]!),
  ad_type: 20,
  sales_form: 1,
  ...over,
})

describe("ingest", () => {
  test("reports every listing as new the first time", () => {
    const changes = store.ingest(realEntries)
    expect(changes).toHaveLength(3)
    expect(changes.every((c) => c.kind === "new")).toBe(true)
  })

  test("a second identical sweep reports nothing", () => {
    store.ingest(realEntries)
    expect(store.ingest(realEntries)).toHaveLength(0)
  })

  test("a price change is reported with the previous price and recorded in history", () => {
    store.ingest([entry()])
    const changes = store.ingest([entry({ price: { amount: 139000 } })])

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: "price", previous: 149000 })
    expect(store.priceHistory(realEntries[0]!.ad_id).map((p) => p.price)).toEqual([149000, 139000])
  })

  test("the same VIN under a new ad id is a relist, not a new car", () => {
    store.ingest([entry({ ad_id: 111, chassis_number: "WVWZZZ1KZAW123456" })])
    const changes = store.ingest([entry({ ad_id: 222, chassis_number: "WVWZZZ1KZAW123456", price: { amount: 129000 } })])

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: "relisted", previousAdId: 111, previousPrice: 149000 })
  })

  test("a listing with no VIN cannot be mistaken for a relist", () => {
    store.ingest([entry({ ad_id: 111, chassis_number: undefined })])
    const changes = store.ingest([entry({ ad_id: 222, chassis_number: undefined })])
    expect(changes[0]!.kind).toBe("new")
  })

  test("stores the fields valuation needs", () => {
    store.ingest(realEntries)
    const row = store.db.query("SELECT * FROM listings WHERE ad_id = ?").get(realEntries[0]!.ad_id) as any
    expect(row.make).toBe("Volkswagen")
    expect(row.year).toBe(2021)
    expect(row.mileage).toBe(152872)
    expect(row.vin).toBe("WV1ZZZ7HZMH110452")
    expect(JSON.parse(row.image_urls).length).toBeGreaterThan(0)
  })
})

describe("delisting", () => {
  test("only listings the sweep actually covered are marked gone", () => {
    store.ingest(realEntries)
    const ids = realEntries.map((e) => e.ad_id)

    // Sweep saw the first two; the third was in scope and is absent.
    const gone = store.markDelisted([ids[0]!, ids[1]!], ids)
    expect(gone).toEqual([ids[2]!])

    const row = store.db.query("SELECT delisted_at FROM listings WHERE ad_id = ?").get(ids[2]!) as any
    expect(row.delisted_at).toBeGreaterThan(0)
  })

  test("a listing that reappears is un-delisted", () => {
    store.ingest(realEntries)
    const ids = realEntries.map((e) => e.ad_id)
    store.markDelisted([], ids)

    store.ingest([entry()])
    const row = store.db.query("SELECT delisted_at FROM listings WHERE ad_id = ?").get(ids[0]!) as any
    expect(row.delisted_at).toBeNull()
  })

  test("nothing is marked when no candidates are supplied", () => {
    store.ingest(realEntries)
    expect(store.markDelisted([], [])).toEqual([])
  })
})

describe("searches and specs", () => {
  test("adding the same URL twice updates rather than duplicates", () => {
    const first = store.addSearch("Golf under 150k", "https://www.finn.no/mobility/search/car?x=1", 150000)
    const second = store.addSearch("Golf under 160k", "https://www.finn.no/mobility/search/car?x=1", 160000)
    expect(second).toBe(first)
    expect(store.listSearches()).toHaveLength(1)
    expect(store.listSearches()[0]!.budget_nok).toBe(160000)
  })

  test("needingSpecs lists only listings without a detail fetch", () => {
    store.ingest(realEntries)
    expect(store.needingSpecs()).toHaveLength(3)

    store.saveSpecs({
      adId: realEntries[0]!.ad_id,
      fields: { Merke: "Volkswagen" },
      equipment: ["Skinnseter"],
      description: "Pen bil",
      euControlDue: "2027-09-03",
    } as any)

    expect(store.needingSpecs()).toHaveLength(2)
  })
})

describe("llm call log", () => {
  test("records attempts and summarises escalation per task and provider", () => {
    store.logLlmCall({ task: "analyze", ref: "477115867", provider: "hugin", model: "m", ok: false, escalateReason: "schema_invalid", latencyMs: 1200, attempt: 1, imageCount: 0 })
    store.logLlmCall({ task: "analyze", ref: "477115867", provider: "openrouter", model: "glm", ok: true, latencyMs: 800, attempt: 1, imageCount: 0 })
    store.logLlmCall({ task: "vision", provider: "hugin", model: "m", ok: true, latencyMs: 4000, attempt: 1, imageCount: 8 })

    const stats = store.llmStats()
    const analyzeHugin = stats.find((s) => s.task === "analyze" && s.provider === "hugin")!
    expect(analyzeHugin.calls).toBe(1)
    expect(analyzeHugin.escalations).toBe(1)
    expect(analyzeHugin.ok).toBe(0)

    const vision = stats.find((s) => s.task === "vision")!
    expect(vision.ok).toBe(1)
  })
})

describe("comparables", () => {
  // Mirrors what live finn data actually looks like: `model` is the generation,
  // `series` reunites generations but also sweeps in the electric variant.
  const golfPopulation = () =>
    store.ingest([
      entry({ ad_id: 1, make: "Volkswagen", series: "Golf-Serie", model: "Golf VII", year: 2016, mileage: 120000, price: { amount: 150000 }, fuel: "Bensin", transmission: "Manuell" }),
      entry({ ad_id: 2, make: "Volkswagen", series: "Golf-Serie", model: "Golf VII", year: 2018, mileage: 90000, price: { amount: 190000 }, fuel: "Bensin", transmission: "Automat" }),
      entry({ ad_id: 3, make: "Volkswagen", series: "Golf-Serie", model: "Golf VI", year: 2012, mileage: 200000, price: { amount: 80000 }, fuel: "Bensin", transmission: "Manuell" }),
      entry({ ad_id: 4, make: "Volkswagen", series: "Golf-Serie", model: "e-Golf VII", year: 2017, mileage: 95000, price: { amount: 130000 }, fuel: "Elektrisitet", transmission: "Automat" }),
      entry({ ad_id: 5, make: "Toyota", series: "Yaris-Serie", model: "Yaris", year: 2017, mileage: 100000, price: { amount: 140000 }, fuel: "Bensin", transmission: "Manuell" }),
    ])

  test("matching on generation is narrow and excludes other generations", () => {
    golfPopulation()
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2015, yearTo: 2019, fuel: "Bensin" })
    expect(comps.map((c) => c.ad_id).sort()).toEqual([1, 2])
  })

  test("matching on series reunites generations — the reason the ladder widens to it", () => {
    golfPopulation()
    const comps = store.comparables({ make: "Volkswagen", series: "Golf-Serie", yearFrom: 2010, yearTo: 2019, fuel: "Bensin" })
    expect(comps.map((c) => c.ad_id).sort()).toEqual([1, 2, 3])
  })

  test("fuel is never widened away, so the e-Golf stays out of a petrol comp set", () => {
    golfPopulation()
    const petrol = store.comparables({ make: "Volkswagen", series: "Golf-Serie", yearFrom: 2015, yearTo: 2019, fuel: "Bensin" })
    expect(petrol.map((c) => c.ad_id)).not.toContain(4)

    const electric = store.comparables({ make: "Volkswagen", series: "Golf-Serie", yearFrom: 2015, yearTo: 2019, fuel: "Elektrisitet" })
    expect(electric.map((c) => c.ad_id)).toEqual([4])
  })

  test("the car being valued is excluded from its own comp set", () => {
    golfPopulation()
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2015, yearTo: 2019, excludeAdId: 1 })
    expect(comps.map((c) => c.ad_id)).toEqual([2])
  })

  test("delisted listings are not comparables", () => {
    golfPopulation()
    store.markDelisted([2], [1, 2])
    const comps = store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2015, yearTo: 2019 })
    expect(comps.map((c) => c.ad_id)).toEqual([2])
  })
})

describe("requirements are scoped to the search that found the car", () => {
  test("a wishlist on one search does not judge a car found by another", () => {
    const tiguan = store.addSearch("Tiguan", "https://www.finn.no/mobility/search/car?a=1", 250000, 6, [
      { text: "skinn", required: true },
    ])
    const cheap = store.addSearch("Billig", "https://www.finn.no/mobility/search/car?b=2", 120000, 6, [])

    store.ingest([entry({ ad_id: 111 })], tiguan)
    store.ingest([entry({ ad_id: 222 })], cheap)

    expect(store.requirementsFor(111).map((r) => r.text)).toEqual(["skinn"])
    expect(store.requirementsFor(222)).toEqual([])
  })

  test("a car found by both searches gets the union, must-have winning", () => {
    const a = store.addSearch("A", "https://www.finn.no/mobility/search/car?a=1", undefined, 6, [{ text: "skinn", required: false }])
    const b = store.addSearch("B", "https://www.finn.no/mobility/search/car?b=2", undefined, 6, [
      { text: "skinn", required: true },
      { text: "hengerfeste", required: false },
    ])
    store.ingest([entry({ ad_id: 333 })], a)
    store.ingest([entry({ ad_id: 333 })], b)

    const reqs = store.requirementsFor(333)
    expect(reqs).toHaveLength(2)
    expect(reqs.find((r) => r.text === "skinn")!.required).toBe(true)
  })

  test("a corpus sweep attaches no search, so it carries no wishlist", () => {
    // Price discovery must not inherit a hunt's requirements.
    store.ingest([entry({ ad_id: 444 })])
    expect(store.requirementsFor(444)).toEqual([])
  })

  test("requirements survive a round trip through the database", () => {
    const id = store.addSearch("R", "https://www.finn.no/mobility/search/car?r=1", undefined, 6, [
      { text: "ryggekamera", required: true },
    ])
    store.ingest([entry({ ad_id: 555 })], id)
    expect(store.requirementsFor(555)).toEqual([{ text: "ryggekamera", required: true }])
  })
})

describe("notifications are only recorded once delivered", () => {
  test("wasNotified is a read that does not itself mark anything", () => {
    // The bug this guards: markNotified() was called BEFORE send(), so a
    // failed delivery burned the deal permanently. 46 cars were marked sent
    // while ntfy was unconfigured and would never have been retried.
    expect(store.wasNotified(1, "deal")).toBe(false)
    expect(store.wasNotified(1, "deal")).toBe(false) // still false — no side effect
    expect(store.db.query("SELECT COUNT(*) n FROM notified").get()).toMatchObject({ n: 0 })
  })

  test("marking is idempotent and only the first call claims it", () => {
    expect(store.markNotified(1, "deal")).toBe(true)
    expect(store.markNotified(1, "deal")).toBe(false)
    expect(store.wasNotified(1, "deal")).toBe(true)
  })

  test("reasons are tracked separately, so a price drop can still alert", () => {
    store.markNotified(1, "deal")
    expect(store.wasNotified(1, "price-drop")).toBe(false)
    expect(store.markNotified(1, "price-drop")).toBe(true)
  })
})


describe("finding price drops", () => {
  const withHistory = (adId: number, prices: number[]) => {
    store.ingest([entry({ ad_id: adId, price: { amount: prices[0]! } })])
    for (const p of prices.slice(1)) store.ingest([entry({ ad_id: adId, price: { amount: p } })])
  }

  test("reports a cut, with the price it came down from", () => {
    withHistory(1, [100_000, 90_000])
    const drops = store.priceDrops()
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ ad_id: 1, price: 90_000, previous_price: 100_000 })
  })

  test("a price RISE is not a drop", () => {
    withHistory(2, [90_000, 100_000])
    expect(store.priceDrops().map((d) => d.ad_id)).not.toContain(2)
  })

  test("an unchanged price is not a drop", () => {
    store.ingest([entry({ ad_id: 3, price: { amount: 100_000 } })])
    store.ingest([entry({ ad_id: 3, price: { amount: 100_000 } })])
    expect(store.priceDrops().map((d) => d.ad_id)).not.toContain(3)
  })

  test("trivial cuts are ignored, since they are not news", () => {
    withHistory(4, [100_000, 99_500])
    expect(store.priceDrops({ minDropNok: 1000 })).toHaveLength(0)
    expect(store.priceDrops({ minDropNok: 100 })).toHaveLength(1)
  })

  test("only the most recent cut is reported, not every step down", () => {
    withHistory(5, [120_000, 110_000, 95_000])
    const drops = store.priceDrops()
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ price: 95_000, previous_price: 110_000 })
  })

  test("a delisted car is not reported, however far it fell", () => {
    withHistory(6, [100_000, 80_000])
    store.db.query("UPDATE listings SET delisted_at = ? WHERE ad_id = 6").run(Date.now())
    expect(store.priceDrops()).toHaveLength(0)
  })

  test("a watched car is reported even below the score threshold", () => {
    // You asked to hear about this one; its score is beside the point.
    // A modest 8% cut, so this tests the watch flag rather than the steepness
    // escape hatch.
    withHistory(7, [100_000, 92_000])
    store.db.query("INSERT INTO valuations (ad_id, computed_at, comp_count, score) VALUES (7, 0, 10, 2)").run()
    expect(store.priceDrops({ minScore: 8 })).toHaveLength(0)

    store.db.query("INSERT INTO watchlist (ad_id, added_at) VALUES (7, 0)").run()
    expect(store.priceDrops({ minScore: 8 })).toHaveLength(1)
  })

  test("watchedOnly excludes everything else", () => {
    withHistory(8, [100_000, 92_000])
    expect(store.priceDrops({ watchedOnly: true })).toHaveLength(0)
  })
})

describe("a steep cut is news regardless of score", () => {
  const withHistory = (adId: number, prices: number[], score?: number) => {
    store.ingest([entry({ ad_id: adId, price: { amount: prices[0]! } })])
    for (const p of prices.slice(1)) store.ingest([entry({ ad_id: adId, price: { amount: p } })])
    if (score != null) store.db.query("INSERT INTO valuations (ad_id, computed_at, comp_count, score) VALUES (?,0,10,?)").run(adId, score)
  }

  test("a 41% cut reports even on a mediocre car", () => {
    // The live case: Mazda CX-5, 84 900 → 50 000 kr, scoring 5.7. A pure
    // score gate said nothing at all.
    withHistory(20, [84_900, 50_000], 5.7)
    expect(store.priceDrops({ minScore: 8 })).toHaveLength(1)
  })

  test("a small cut on a mediocre car stays quiet", () => {
    withHistory(21, [100_000, 97_000], 5.7)
    expect(store.priceDrops({ minScore: 8 })).toHaveLength(0)
  })

  test("a small cut on a good car still reports", () => {
    withHistory(22, [100_000, 97_000], 9.1)
    expect(store.priceDrops({ minScore: 8 })).toHaveLength(1)
  })

  test("the steepness threshold is adjustable", () => {
    withHistory(23, [100_000, 82_000], 1)
    expect(store.priceDrops({ minScore: 8, bigDropPct: 0.15 })).toHaveLength(1)
    expect(store.priceDrops({ minScore: 8, bigDropPct: 0.25 })).toHaveLength(0)
  })
})

describe("managing searches", () => {
  test("a search can be deleted, and its listings survive", () => {
    // Listings are market data. Throwing away comparables because a hunt was
    // renamed would quietly degrade every valuation that used them.
    const id = store.addSearch("Slettes", "https://www.finn.no/mobility/search/car?z=1")
    store.ingest([entry({ ad_id: 900 })], id)
    expect(store.listSearches(false)).toHaveLength(1)

    expect(store.deleteSearch(id)).toBe(true)
    expect(store.listSearches(false)).toHaveLength(0)
    expect(store.db.query("SELECT 1 FROM listings WHERE ad_id = 900").get()).not.toBeNull()
  })

  test("deleting unlinks it, so its requirements stop applying", () => {
    const id = store.addSearch("Med ønsker", "https://www.finn.no/mobility/search/car?z=2", undefined, 6, [
      { text: "skinn", required: true },
    ])
    store.ingest([entry({ ad_id: 901 })], id)
    expect(store.requirementsFor(901)).toHaveLength(1)

    store.deleteSearch(id)
    expect(store.requirementsFor(901)).toEqual([])
  })

  test("deleting one search leaves another's link intact", () => {
    const a = store.addSearch("A", "https://www.finn.no/mobility/search/car?a=1", undefined, 6, [{ text: "skinn", required: true }])
    const b = store.addSearch("B", "https://www.finn.no/mobility/search/car?b=1", undefined, 6, [{ text: "hengerfeste", required: false }])
    store.ingest([entry({ ad_id: 902 })], a)
    store.ingest([entry({ ad_id: 902 })], b)

    store.deleteSearch(a)
    expect(store.requirementsFor(902).map((r) => r.text)).toEqual(["hengerfeste"])
  })

  test("deleting something that is not there reports so", () => {
    expect(store.deleteSearch(4242)).toBe(false)
  })

  test("pausing stops it being swept but keeps the configuration", () => {
    const id = store.addSearch("Pauses", "https://www.finn.no/mobility/search/car?p=1", 150000)
    store.setSearchActive(id, false)

    expect(store.listSearches(true)).toHaveLength(0) // not swept
    expect(store.listSearches(false)).toHaveLength(1) // still configured
    expect(store.getSearch(id)?.budget_nok).toBe(150000)

    store.setSearchActive(id, true)
    expect(store.listSearches(true)).toHaveLength(1)
  })

  test("a paused search's requirements stop applying too", () => {
    const id = store.addSearch("P", "https://www.finn.no/mobility/search/car?p=2", undefined, 6, [{ text: "skinn", required: true }])
    store.ingest([entry({ ad_id: 903 })], id)
    expect(store.requirementsFor(903)).toHaveLength(1)

    store.setSearchActive(id, false)
    expect(store.requirementsFor(903)).toEqual([])
  })

  test("the feed can be told which searches found each listing", () => {
    const a = store.addSearch("A", "https://www.finn.no/mobility/search/car?x=1")
    const b = store.addSearch("B", "https://www.finn.no/mobility/search/car?x=2")
    store.ingest([entry({ ad_id: 910 })], a)
    store.ingest([entry({ ad_id: 910 })], b)
    store.ingest([entry({ ad_id: 911 })], b)

    const map = store.searchIdsByListing()
    expect(map.get(910)!.sort()).toEqual([a, b].sort())
    expect(map.get(911)).toEqual([b])
  })
})
