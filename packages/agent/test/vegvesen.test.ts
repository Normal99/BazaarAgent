import { expect, test, describe } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mapVehicle, crossCheck, inferEuControl } from "../src/vegvesen.ts"

// A real response from the live Vegvesen registry, captured 2026-09-23, trimmed
// only of subtrees the mapper never reads.
//
// It replaced a hand-written fixture built from another project's field paths,
// which is worth remembering: that fixture encoded the wrong nesting, so these
// tests passed green against a mapper that returned undefined for power, CO2
// and drivetrain on every real vehicle. A fixture invented from documentation
// tests the invention, not the integration.
const registryResponse = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "vegvesen-FT69617.json"), "utf8"))

describe("registry mapping", () => {
  test("extracts the EU-kontroll date the advertisement usually omits", () => {
    const facts = mapVehicle(registryResponse)!
    expect(facts.euControlDue).toBe("2027-09-03")
    expect(facts.euControlLastApproved).toBe("2025-08-29")
  })

  test("reads power from under the fuel entry, not off the motor", () => {
    // motor[0].drivstoff[0].maksNettoEffekt = 110 kW. Reading
    // motor[0].maksNettoEffekt gives undefined on every real vehicle.
    expect(mapVehicle(registryResponse)!.powerHk).toBe(150)
  })

  test("normalises the plate, which the registry spaces and finn does not", () => {
    // Registry says "FT 69617", finn says "FT69617" — unnormalised they never join.
    expect(mapVehicle(registryResponse)!.regno).toBe("FT69617")
  })

  test("derives drivetrain by counting driven axles, as there is no such field", () => {
    expect(mapVehicle(registryResponse)!.drivetrain).toBe("Firehjulsdrift")
  })

  test("prefers the NEDC CO2 figure finn quotes, keeping WLTP alongside", () => {
    // The same van reports 182 NEDC and 217 WLTP; picking the wrong one makes
    // any comparison against the ad look like a discrepancy.
    const facts = mapVehicle(registryResponse)!
    expect(facts.co2).toBe(182)
    expect(facts.co2Wltp).toBe(217)
  })

  test("pulls the technical facts used for valuation", () => {
    const facts = mapVehicle(registryResponse)!
    expect(facts.make).toBe("VOLKSWAGEN")
    expect(facts.modelName).toBe("TRANSPORTER")
    expect(facts.fuel).toBe("Diesel")
    expect(facts.gearbox).toBe("Automat")
    expect(facts.engineCc).toBe(1968)
    expect(facts.kerbWeightKg).toBe(2185)
    expect(facts.fuelConsumption).toBe(8.3)
    expect(facts.vin).toBe("WV1ZZZ7HZMH110452")
  })

  test("survives a sparse response rather than throwing", () => {
    const facts = mapVehicle({ kjoretoydataListe: [{ kjoretoyId: { kjennemerke: "AB12345" } }] })!
    expect(facts.regno).toBe("AB12345")
    expect(facts.euControlDue).toBeUndefined()
    expect(facts.usedImport).toBe(false)
  })

  test("returns undefined for an empty result", () => {
    expect(mapVehicle({ kjoretoydataListe: [] })).toBeUndefined()
    expect(mapVehicle({})).toBeUndefined()
  })
})

describe("cross-checking the registry against the ad", () => {
  // The captured vehicle is a domestic, non-imported van, so these build on top
  // of the real mapped facts rather than a real import response. crossCheck is
  // pure logic over VehicleFacts, so that is sound here — unlike the mapper,
  // which has to meet the registry's actual nesting.
  const imported = { ...mapVehicle(registryResponse)!, usedImport: true, importMileage: 98_000 }
  const normalise = (findings: string[]) => findings.map((f) => f.replace(/[  ]/g, " "))

  test("flags a used import, which ads rarely mention", () => {
    expect(crossCheck(imported, { mileage: 152_872 }).some((f) => f.includes("Bruktimportert"))).toBe(true)
  })

  test("catches a stated mileage below what was recorded at import", () => {
    // The registry is the one source the seller does not control.
    const findings = normalise(crossCheck(imported, { mileage: 80_000 }))
    expect(findings.some((f) => f.includes("98 000 km"))).toBe(true)
    expect(findings.some((f) => f.includes("80 000 km"))).toBe(true)
  })

  test("says nothing about a domestic car whose ad agrees with the registry", () => {
    expect(crossCheck(mapVehicle(registryResponse)!, { mileage: 152_872 })).toEqual([])
  })
})

describe("EU-kontroll inference, for when the registry is unavailable", () => {
  test("first inspection in year four, then every second year", () => {
    // Registered 2021 → first due 2025; by 2026 that has passed, so the next is 2027.
    expect(inferEuControl("03.09.2021", 2026)!.dueYear).toBe(2027)
    expect(inferEuControl("03.09.2021", 2024)!.dueYear).toBe(2025)
    expect(inferEuControl("03.09.2014", 2026)!.dueYear).toBe(2026)
    expect(inferEuControl("03.09.2013", 2026)!.dueYear).toBe(2027)
  })

  test("marks itself as inferred so the UI never presents it as verified", () => {
    const estimate = inferEuControl("03.09.2021", 2026)!
    expect(estimate.source).toBe("inferred")
    expect(estimate.note).toContain("Ikke bekreftet")
  })

  test("returns nothing rather than guessing from unusable input", () => {
    expect(inferEuControl(undefined)).toBeUndefined()
    expect(inferEuControl("ukjent")).toBeUndefined()
    expect(inferEuControl("03.09.1890")).toBeUndefined()
  })
})
