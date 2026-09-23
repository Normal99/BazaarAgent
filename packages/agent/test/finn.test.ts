import { expect, test, describe } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSearchPage, normalizeSearchUrl, extractSearchState, checkFilters, ParseError } from "../src/finn/search.ts"
import { parseItemPage, parseSpecFields, parseNorwegianNumber, imageVariant } from "../src/finn/item.ts"

// The fixtures are real finn.no responses captured on 2026-09-23, trimmed to a
// few listings. Parsing invented HTML would prove nothing about finn's actual
// output, which is the only thing these parsers have to survive.
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
const searchHtml = fixture("search-car.html")
const itemHtml = fixture("item-477115867.html")

describe("search page", () => {
  test("decodes the base64 hydration blob into listings", () => {
    const page = parseSearchPage(searchHtml)
    expect(page.entries).toHaveLength(3)
    expect(page.matchCount).toBeGreaterThan(1000)
    expect(page.lastPage).toBe(50)
  })

  test("carries the fields the valuation depends on", () => {
    const [first] = parseSearchPage(searchHtml).entries
    expect(first!.ad_id).toBe(477115867)
    expect(first!.make).toBe("Volkswagen")
    expect(first!.model).toBe("Transporter")
    expect(first!.year).toBe(2021)
    expect(first!.mileage).toBe(152872)
    expect(first!.price.amount).toBe(149000)
    expect(first!.fuel).toBe("Diesel")
    expect(first!.transmission).toBe("Automat")
    expect(first!.dealer_segment).toBe("Forhandler")
  })

  test("carries plate and VIN, which relist detection and Vegvesen need", () => {
    const [first] = parseSearchPage(searchHtml).entries
    expect(first!.regno).toBe("FT69617")
    expect(first!.chassis_number).toBe("WV1ZZZ7HZMH110452")
    expect(first!.coordinates?.lat).toBeCloseTo(60.83, 1)
    expect(first!.image_urls?.length).toBeGreaterThan(0)
  })

  test("fails loudly when the page shape changes rather than importing nothing", () => {
    expect(() => parseSearchPage("<html><body>no blob here</body></html>")).toThrow(ParseError)
    expect(() => extractSearchState("<html></html>")).toThrow(/page structure has changed/)
  })

  test("a blob that is valid base64 but not the search query is still an error", () => {
    const blob = Buffer.from(JSON.stringify({ queries: [{ queryKey: [{ scope: "seo" }] }] })).toString("base64")
    expect(() => parseSearchPage(`<script type="application/json" data-react-query-state>${blob}</script>`)).toThrow(/scope "search"/)
  })
})

describe("search URL handling", () => {
  test("accepts a pasted saved-search URL and strips paging", () => {
    const url = normalizeSearchUrl("https://www.finn.no/mobility/search/car?price_to=150000&year_from=2015&page=3")
    expect(url.searchParams.get("price_to")).toBe("150000")
    expect(url.searchParams.get("year_from")).toBe("2015")
    expect(url.searchParams.has("page")).toBe(false)
  })

  test("rejects anything that is not a finn mobility search", () => {
    expect(() => normalizeSearchUrl("https://www.blocket.se/annonser")).toThrow(/not finn.no/)
    expect(() => normalizeSearchUrl("https://www.finn.no/realestate/homes")).toThrow(/Only \/mobility\/search/)
    expect(() => normalizeSearchUrl("not a url")).toThrow(/is not a URL/)
  })
})

describe("item page", () => {
  test("reads the dt/dd spec table", () => {
    const fields = parseSpecFields(itemHtml)
    expect(Object.keys(fields).length).toBeGreaterThan(15)
    expect(fields["Merke"]).toBe("Volkswagen")
    expect(fields["Girkasse"]).toBe("Automat")
  })

  test("extracts the fields that drive valuation and negotiation", () => {
    const specs = parseItemPage(itemHtml, 477115867)
    expect(specs.regno).toBe("FT69617")
    expect(specs.vin).toBe("WV1ZZZ7HZMH110452")
    expect(specs.firstRegistered).toBe("03.09.2021")
    expect(specs.mileage).toBe(152872)
    expect(specs.priceExclRegistration).toBe(147447)
    expect(specs.power).toBe(149)
    expect(specs.co2).toBe(178)
    expect(specs.colour).toBe("Sølv")
    expect(specs.salesForm).toBe("Auksjon")
  })

  test("fails loudly when the spec table is gone", () => {
    expect(() => parseItemPage("<html><body><p>nothing</p></body></html>", 1)).toThrow(/spec table/)
  })
})

describe("Norwegian number parsing", () => {
  test("handles the separators finn actually uses", () => {
    expect(parseNorwegianNumber("152 872 km")).toBe(152872)
    expect(parseNorwegianNumber("147 447 kr")).toBe(147447) // non-breaking space
    expect(parseNorwegianNumber("2,0 L")).toBe(2.0)
    expect(parseNorwegianNumber("178 g/km")).toBe(178)
    expect(parseNorwegianNumber("1 957 kg")).toBe(1957)
    expect(parseNorwegianNumber(undefined)).toBeUndefined()
    expect(parseNorwegianNumber("ikke oppgitt")).toBeUndefined()
  })
})

describe("image variants", () => {
  test("rewrites the finncdn size segment to control vision cost", () => {
    const original = "https://images.finncdn.no/dynamic/default/item/477115867/6d68792f-b08c-42d8-a5e7-fbc26ddeabc9"
    expect(imageVariant(original, "640w")).toBe(
      "https://images.finncdn.no/dynamic/640w/item/477115867/6d68792f-b08c-42d8-a5e7-fbc26ddeabc9",
    )
    expect(imageVariant(original, "1280w")).toContain("/dynamic/1280w/item/")
    // Already-sized URLs are rewritten too, not doubled up.
    expect(imageVariant(imageVariant(original, "1600w"), "640w")).toContain("/dynamic/640w/item/")
  })
})

describe("detecting filters finn silently dropped", () => {
  const page = (selected: string[][], matchCount: number) => {
    const blob = Buffer.from(
      JSON.stringify({
        queries: [
          {
            queryKey: [{ scope: "search" }],
            state: {
              data: {
                docs: [],
                metadata: {
                  result_size: { match_count: matchCount },
                  selected_filters: selected.map((names) => ({ parameters: names.map((n) => ({ parameter_name: n })) })),
                },
              },
            },
          },
        ],
      }),
    ).toString("base64")
    return `<script type="application/json" data-react-query-state>${blob}</script>`
  }

  test("reports a parameter finn ignored", () => {
    // Live: ?make=0.817&model=1.817.1621&price_to=250000 came back with only
    // the price applied and 38 394 matches — nearly the whole market — while
    // looking like a properly configured Tiguan search.
    const url = new URL("https://www.finn.no/mobility/search/car?make=0.817&model=1.817.1621&price_to=250000")
    const check = checkFilters(page([["price_to"]], 38_394), url)
    expect(check.ignored.sort()).toEqual(["make", "model"])
    expect(check.matchCount).toBe(38_394)
  })

  test("make is honoured but echoed back as variant, and is not a false alarm", () => {
    const url = new URL("https://www.finn.no/mobility/search/car?make=0.817&price_to=200000")
    expect(checkFilters(page([["variant"], ["price_to"]], 4_691), url).ignored).toEqual([])
  })

  test("a fully honoured search reports nothing", () => {
    const url = new URL("https://www.finn.no/mobility/search/car?variant=1.817.2834&price_to=250000")
    expect(checkFilters(page([["variant"], ["price_to"]], 304), url).ignored).toEqual([])
  })

  test("sort and paging are not filters and are never reported", () => {
    const url = new URL("https://www.finn.no/mobility/search/car?price_to=120000&sort=PUBLISHED_DESC&page=2")
    expect(checkFilters(page([["price_to"]], 100), url).ignored).toEqual([])
  })

  test("a search with no filters at all is not an error", () => {
    expect(checkFilters(page([], 50_000), new URL("https://www.finn.no/mobility/search/car")).ignored).toEqual([])
  })
})
