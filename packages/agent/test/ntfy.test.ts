import { expect, test, describe } from "bun:test"
import { encodeHeader, dealNotification, dropNotification } from "../src/notify/ntfy.ts"

describe("header encoding", () => {
  test("Norwegian titles survive the trip", () => {
    // The bug this guards: percent-encoding plus an invented X-Title-Encoding
    // header meant a phone displayed the literal
    // "119%C2%A0900%20kr%20%C2%B7%20Audi". RFC 2047 is what ntfy decodes,
    // verified live against ntfy.sh.
    const encoded = encodeHeader("119 900 kr · Vålerenga æøå")
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true)
    expect(encoded.endsWith("?=")).toBe(true)
    expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8")).toBe("119 900 kr · Vålerenga æøå")
  })

  test("plain ASCII is left alone, so logs stay readable", () => {
    expect(encodeHeader("119 900 kr - Audi A4")).toBe("119 900 kr - Audi A4")
  })

  test("the non-breaking space nb-NO formatting produces is handled", () => {
    // toLocaleString("nb-NO") uses U+00A0, which is not ASCII.
    const title = `${(119900).toLocaleString("nb-NO")} kr`
    expect(encodeHeader(title).startsWith("=?UTF-8?B?")).toBe(true)
  })

  test("never emits a raw control character or newline into a header", () => {
    for (const value of ["a\nb", "Bil · høy\tkvalitet", "æøå"]) {
      const out = encodeHeader(value)
      expect(out.includes("\n")).toBe(false)
      expect(out.includes("\t")).toBe(false)
    }
  })
})

describe("what a deal notification says", () => {
  const deal = (over: any = {}) => ({
    listing: { heading: "Volkswagen Tiguan", year: 2016, mileage: 84865, price: 159900, dealer_segment: "Privat", location: "Sandvika", url: "https://finn.no/x", ...over.listing },
    valuation: { fairValue: 211982, residualPct: 0.25 },
    score: 8.9,
    parts: [],
    registryFindings: [],
    ...over,
  })

  test("leads with price and car, since that is the lock-screen glance", () => {
    const n = dealNotification(deal() as any)
    expect(n.title).toContain("Volkswagen Tiguan")
    expect(n.title).toContain("159")
  })

  test("says how far under the market it is", () => {
    expect(dealNotification(deal() as any).body).toContain("25% under marked")
  })

  test("the over-budget-but-reachable case is the headline", () => {
    const n = dealNotification(deal({ plan: { haggleableIntoBudget: true, overBudgetBy: 9900, target: 148000 } }) as any, 150000)
    expect(n.body).toContain("over budsjett")
    expect(n.tags).toContain("handshake")
  })

  test("a registry contradiction is surfaced, being the strongest signal", () => {
    const n = dealNotification(deal({ registryFindings: ["Bruktimportert ifølge registeret"] }) as any)
    expect(n.body).toContain("Bruktimportert")
    expect(n.tags).toContain("warning")
  })

  test("a high score raises priority so it is not buried", () => {
    expect(dealNotification(deal({ score: 9.4 }) as any).priority).toBe(4)
    expect(dealNotification(deal({ score: 6.5 }) as any).priority).toBe(3)
  })

  test("tapping it opens the listing", () => {
    expect(dealNotification(deal() as any).click).toBe("https://finn.no/x")
  })
})

describe("price-drop alerts", () => {
  const drop = (over: any = {}) => ({
    heading: "Mazda CX-5",
    url: "https://finn.no/x",
    price: 50_000,
    previous_price: 84_900,
    year: 2013,
    mileage: 124_000,
    location: "Inderøy",
    fair_value: 72_000,
    watched: 0,
    ...over,
  })

  // nb-NO number formatting uses U+00A0 as the thousands separator, so a
  // literal with an ordinary space never matches.
  const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ")

  test("leads with the size of the cut, not the new price", () => {
    // On a lock screen the news is that it moved and by how much.
    const n = dropNotification(drop())
    expect(plain(n.title)).toContain("34 900")
    expect(n.title).toContain("Mazda CX-5")
  })

  test("shows both prices and the percentage", () => {
    const body = plain(dropNotification(drop()).body)
    expect(body).toContain("84 900")
    expect(body).toContain("50 000")
    expect(body).toContain("41 %")
  })

  test("says where it now sits against the market", () => {
    expect(dropNotification(drop()).body).toContain("under marked")
  })

  test("a cut on a followed car is louder than one on a stranger", () => {
    // You already decided you wanted this one; the cut is a specific opening.
    expect(dropNotification(drop({ watched: 1 })).priority).toBe(4)
    expect(dropNotification(drop({ watched: 0 })).priority).toBe(3)
    expect(dropNotification(drop({ watched: 1 })).tags).toContain("star")
  })

  test("omits the market line when there is no valuation to compare against", () => {
    expect(dropNotification(drop({ fair_value: null })).body).not.toContain("under marked")
  })

  test("a Norwegian heading survives the header encoding", () => {
    expect(dropNotification(drop({ heading: "Citroën Berlingo æøå" })).title.startsWith("=?UTF-8?B?")).toBe(false)
    expect(encodeHeader(dropNotification(drop({ heading: "Citroën æøå" })).title).startsWith("=?UTF-8?B?")).toBe(true)
  })
})
