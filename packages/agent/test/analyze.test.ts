import { expect, test, describe } from "bun:test"
import { AnalysisSchema } from "../src/llm/analyze.ts"
import { selectImages } from "../src/llm/images.ts"

describe("analysis schema", () => {
  // Regression: the first live probe failed validation because the model sent
  // `imageIndex: null` on text-sourced flags — correct behaviour, since a text
  // claim has no photo — while the field was declared `.optional()`, which
  // accepts absence but not null. That cost a 16s repair round-trip and made a
  // working provider look unreliable.
  test("accepts explicit nulls for fields that do not apply", () => {
    const reply = {
      redFlags: [
        { claim: "Selges som den er", source: "tekst", evidence: "«selges som den er»", severity: "høy", imageIndex: null },
        { claim: "Rust på terskel", source: "bilde", evidence: "tydelig gjennomrust", severity: "høy", imageIndex: 3 },
      ],
      greenFlags: [{ claim: "Nye dekk", source: "tekst", evidence: "«nye vinterdekk»", severity: null, imageIndex: null }],
      levers: [{ claim: "Rustreparasjon", evidence: "bilde 3", estValueNok: 15000 }],
      odometerSeenKm: null,
      summaryNo: "Kort oppsummering.",
    }
    const parsed = AnalysisSchema.safeParse(reply)
    expect(parsed.success).toBe(true)
  })

  test("accepts the fields being absent entirely", () => {
    const parsed = AnalysisSchema.safeParse({
      redFlags: [{ claim: "x", source: "tekst", evidence: "y" }],
      greenFlags: [],
      levers: [],
      summaryNo: "s",
    })
    expect(parsed.success).toBe(true)
  })

  test("still rejects a genuinely wrong shape", () => {
    expect(AnalysisSchema.safeParse({ redFlags: "none", greenFlags: [], levers: [], summaryNo: "s" }).success).toBe(false)
    // A source outside the enum is a real error, not a null to tolerate.
    expect(
      AnalysisSchema.safeParse({ redFlags: [{ claim: "x", source: "photo", evidence: "y" }], greenFlags: [], levers: [], summaryNo: "s" }).success,
    ).toBe(false)
  })

  test("caps an implausible lever value", () => {
    expect(
      AnalysisSchema.safeParse({
        redFlags: [], greenFlags: [],
        levers: [{ claim: "x", evidence: "y", estValueNok: 900_000 }],
        summaryNo: "s",
      }).success,
    ).toBe(false)
  })
})

describe("image selection", () => {
  const album = Array.from({ length: 16 }, (_, i) => `https://images.finncdn.no/dynamic/default/item/1/img${i}`)

  test("rewrites to the cheap 640w variant", () => {
    for (const image of selectImages(album)) expect(image.url).toContain("/dynamic/640w/item/")
  })

  test("spreads across the album rather than taking the first eight", () => {
    // Sellers order photos conventionally, so the first eight would be eight
    // shots of the same corner. Measured on a real 16-photo ad: 0,1,2,4,6,9,11,13.
    const indices = selectImages(album).map((i) => Number(i.url.match(/img(\d+)$/)![1]))
    expect(indices).toHaveLength(8)
    expect(indices[0]).toBe(0)
    expect(indices[1]).toBe(1)
    expect(Math.max(...indices)).toBeGreaterThan(10)
    expect(new Set(indices).size).toBe(8)
  })

  test("returns every photo when the album is smaller than the cap", () => {
    expect(selectImages(album.slice(0, 5))).toHaveLength(5)
  })

  test("handles an ad with no photos", () => {
    expect(selectImages([])).toEqual([])
  })
})
