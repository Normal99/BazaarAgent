import { expect, test, describe } from "bun:test"
import { matchFromText, matchAll, summarise, expand, parseRequirements, formatRequirements } from "../src/value/requirements.ts"
import { scoreListing } from "../src/value/score.ts"

const want = (text: string, required = false) => ({ text, required })

describe("synonym expansion", () => {
  test("bridges the spellings Norwegian sellers actually use", () => {
    // Someone typing "skinn" must match an ad listing "Skinninteriør".
    expect(expand("skinn")).toContain("skinninteriør")
    expect(expand("skinnseter")).toContain("skinn")
    // And the near-miss that plain substring matching gets wrong.
    expect(expand("hengerfeste")).toContain("tilhengerfeste")
    expect(expand("4x4")).toContain("firehjulsdrift")
    expect(expand("automat")).toContain("dsg")
  })

  test("leaves an unknown term alone rather than inventing matches", () => {
    expect(expand("bagasjeromstrekk")).toEqual(["bagasjeromstrekk"])
  })
})

describe("matching against a listing", () => {
  const listing = {
    equipment: ["Skinnseter", "Navigasjonssystem", "Tilhengerfeste", "Parkeringssensor bak"],
    modelSpecification: "2.0 TDI 4Motion Highline DSG",
    description: "Pen bil med hengerfeste montert i fjor. Ingen soltak.",
    fields: { Hjuldrift: "Firehjulsdrift", Girkasse: "Automat" },
  }

  test("finds it in the equipment list, which is the most reliable source", () => {
    const m = matchFromText(want("skinn"), listing)
    expect(m.status).toBe("ja")
    expect(m.source).toBe("utstyr")
    expect(m.evidence).toBe("Skinnseter")
  })

  test("finds it in the technical data", () => {
    const m = matchFromText(want("firehjulsdrift"), listing)
    expect(m.status).toBe("ja")
    expect(m.source).toBe("spesifikasjon")
  })

  test("finds it in the trim name", () => {
    const m = matchFromText(want("dsg"), listing)
    expect(m.status).toBe("ja")
    expect(m.evidence).toContain("DSG")
  })

  test("quotes the ad text so the claim stays checkable", () => {
    const m = matchFromText(want("hengerfeste"), { description: listing.description })
    expect(m.status).toBe("ja")
    expect(m.source).toBe("tekst")
    expect(m.evidence).toContain("hengerfeste")
  })

  test("answers kanskje, not nei, when nothing mentions it", () => {
    // Absence from an equipment list is weak evidence — plenty of sellers
    // fill in nothing at all. Saying "nei" here would discard good cars.
    const m = matchFromText(want("ryggekamera"), listing)
    expect(m.status).toBe("kanskje")
    expect(m.source).toBe("ukjent")
  })

  test("handles a listing with no detail page fetched yet", () => {
    expect(matchFromText(want("skinn"), {}).status).toBe("kanskje")
  })
})

describe("verdict", () => {
  test("a missing must-have is close to disqualifying", () => {
    const matches = [
      { requirement: "skinn", required: true, status: "nei" as const, source: "utstyr" as const },
      { requirement: "navi", required: false, status: "ja" as const, source: "utstyr" as const },
    ]
    const verdict = summarise(matches)
    expect(verdict.failed).toHaveLength(1)
    expect(verdict.scoreDelta).toBeLessThan(-3)
  })

  test("an unconfirmed must-have is only a caution", () => {
    const verdict = summarise([{ requirement: "skinn", required: true, status: "kanskje", source: "ukjent" }])
    expect(verdict.unresolved).toHaveLength(1)
    expect(verdict.scoreDelta).toBeGreaterThan(-1)
  })

  test("meeting the nice-to-haves helps, without dominating price", () => {
    const all = summarise([
      { requirement: "a", required: false, status: "ja", source: "utstyr" },
      { requirement: "b", required: false, status: "ja", source: "utstyr" },
    ])
    expect(all.scoreDelta).toBeGreaterThan(0)
    expect(all.scoreDelta).toBeLessThan(1.5)
    expect(all.metOptional).toBe(2)
  })

  test("no requirements means no adjustment at all", () => {
    expect(summarise([]).scoreDelta).toBe(0)
  })
})

describe("scoring", () => {
  const base = { residualPct: 0.15, confidence: "high" as const, year: 2018, mileage: 100_000, now: new Date("2026-09-23").getTime() }

  test("a car missing a must-have drops below a plain one", () => {
    // A car without the thing you need is not a cheap version of the car you
    // wanted; it is a different car, and no discount fixes that.
    const plain = scoreListing(base).score
    const missing = scoreListing({ ...base, requirementDelta: -4 }).score
    expect(missing).toBeLessThan(plain - 2)
  })

  test("having the extras nudges it up and is labelled", () => {
    const withExtras = scoreListing({ ...base, requirementDelta: 1.2 })
    expect(withExtras.score).toBeGreaterThan(scoreListing(base).score)
    expect(withExtras.parts.some((p) => p.label.includes("ønsket utstyr"))).toBe(true)
  })
})

describe("the input syntax", () => {
  test("a trailing ! marks a must-have", () => {
    const parsed = parseRequirements("skinn!, hengerfeste, ryggekamera!")
    expect(parsed).toEqual([
      { text: "skinn", required: true },
      { text: "hengerfeste", required: false },
      { text: "ryggekamera", required: true },
    ])
  })

  test("survives sloppy spacing and empty entries", () => {
    expect(parseRequirements("  skinn ! ,, , hengerfeste  ")).toHaveLength(2)
    expect(parseRequirements("")).toEqual([])
  })

  test("round-trips", () => {
    const text = "skinn!, hengerfeste"
    expect(formatRequirements(parseRequirements(text))).toBe(text)
  })
})

describe("matchAll", () => {
  test("returns one entry per requirement, in order", () => {
    const matches = matchAll([want("skinn", true), want("soltak")], { equipment: ["Skinnseter"] })
    expect(matches.map((m) => m.requirement)).toEqual(["skinn", "soltak"])
    expect(matches[0].status).toBe("ja")
    expect(matches[0].required).toBe(true)
    expect(matches[1].status).toBe("kanskje")
  })
})

describe("extras never rescue a missing must-have", () => {
  test("a sunroof does not offset a missing towbar", () => {
    const withExtra = summarise([
      { requirement: "hengerfeste", required: true, status: "nei", source: "utstyr" },
      { requirement: "soltak", required: false, status: "ja", source: "utstyr" },
    ])
    const without = summarise([{ requirement: "hengerfeste", required: true, status: "nei", source: "utstyr" }])
    expect(withExtra.scoreDelta).toBe(without.scoreDelta)
  })
})

describe("synonym groups must not bleed into each other", () => {
  test("asking for an automatic gearbox does not match air conditioning", () => {
    // Live failure: "klimaautomatikk" contains "automat", so substring-based
    // group lookup pulled in the whole klima group and reported "Klimaanlegg"
    // as evidence of an automatic gearbox on a 2016 Outlander.
    expect(expand("automat")).not.toContain("klimaanlegg")
    expect(matchFromText(want("automat"), { equipment: ["Klimaanlegg"] }).status).toBe("kanskje")
  })

  test("nor automatic headlights", () => {
    expect(matchFromText(want("automat"), { equipment: ["Automatisk tenning hovedlys"] }).status).toBe("kanskje")
  })

  test("but a real automatic still matches", () => {
    expect(matchFromText(want("automat"), { fields: { Girkasse: "Automat" } }).status).toBe("ja")
    expect(matchFromText(want("automat"), { equipment: ["DSG girkasse"] }).status).toBe("ja")
  })

  test("a text quote stays on one line so it reads as evidence", () => {
    const m = matchFromText(want("hengerfeste"), { description: "Praktisk:\n\nHengerfeste\n\nAutomat\n\nCruise" })
    expect(m.status).toBe("ja")
    expect(m.evidence).not.toContain("\n")
  })
})

describe("a leather steering wheel is not leather seats", () => {
  test("an accessory-only mention does not satisfy a must-have", () => {
    // Live: a 2018 Volvo V60 listed "Skinnratt" and a 2023 Opel Vivaro
    // "Ratt, skinn". Either one satisfied a must-have for "skinn" and would
    // have sent someone to view a car with cloth seats.
    for (const item of ["Skinnratt", "Ratt, skinn", "Girspak i skinn"]) {
      const m = matchFromText(want("skinn", true), { equipment: [item] })
      expect(m.status).toBe("kanskje")
      expect(m.evidence).toContain(item)
    }
  })

  test("but real leather elsewhere in the list still wins", () => {
    const m = matchFromText(want("skinn"), { equipment: ["Skinnratt", "Skinnseter"] })
    expect(m.status).toBe("ja")
    expect(m.evidence).toBe("Skinnseter")
  })

  test("an entry naming both is not accessory-only", () => {
    expect(matchFromText(want("skinn"), { equipment: ["Skinnseter og skinnratt"] }).status).toBe("ja")
  })

  test("the description can still settle it after a weak equipment hit", () => {
    const m = matchFromText(want("skinn"), { equipment: ["Skinnratt"], description: "Bilen har skinnseter i god stand." })
    expect(m.status).toBe("ja")
    expect(m.source).toBe("tekst")
  })

  test("the rule is scoped to leather, not applied to everything", () => {
    expect(matchFromText(want("ryggekamera"), { equipment: ["Ryggekamera"] }).status).toBe("ja")
  })
})

describe("evidence quotes point at the real match", () => {
  test("the quote is located in the raw text, not the normalised copy", () => {
    // Normalising strips punctuation and collapses whitespace, so an index
    // taken from it lands elsewhere in the original. Live, a match on
    // "ryggekamera" quoted a passage about towbars.
    const description = "Utstyr, bl.a.: Hengerfeste! Automat; Cruisekontroll — og Ryggekamera bak."
    const m = matchFromText(want("ryggekamera"), { description })
    expect(m.status).toBe("ja")
    expect(m.evidence!.toLowerCase()).toContain("ryggekamera")
  })

  test("a match at the very start of the text quotes cleanly", () => {
    const m = matchFromText(want("hengerfeste"), { description: "Hengerfeste montert i fjor." })
    expect(m.evidence).toContain("Hengerfeste")
  })

  test("case is ignored when locating the quote", () => {
    expect(matchFromText(want("hengerfeste"), { description: "HENGERFESTE følger med" }).status).toBe("ja")
  })
})
