import { expect, test, describe } from "bun:test"
import { mapVehicle, crossCheck, inferEuControl } from "../src/vegvesen.ts"

// Shaped from a working integration against the same endpoint (Normal99/Autonett),
// not from the published docs, which do not describe the response. Marked here
// because it has not yet been re-verified against a live call — that needs a
// current API key.
const registryResponse = {
  kjoretoydataListe: [
    {
      kjoretoyId: { kjennemerke: "FT69617", understellsnummer: "WV1ZZZ7HZMH110452" },
      periodiskKjoretoyKontroll: { kontrollfrist: "2027-09-30", sistGodkjent: "2025-09-12" },
      forstegangsregistrering: { registrertForstegangNorgeDato: "2021-09-03" },
      godkjenning: {
        forstegangsGodkjenning: {
          forstegangRegistrertDato: "2021-09-03",
          bruktimport: { kilometerstand: 98000 },
        },
        tekniskGodkjenning: {
          tekniskeData: {
            generelt: { merke: [{ merke: "VOLKSWAGEN" }], handelsbetegnelse: ["TRANSPORTER"] },
            motorOgDrivverk: { motor: [{ maksNettoEffekt: 110, slagvolum: 1968 }], girkassetype: { kodeNavn: "Automat" } },
            akslinger: { forbindelseMellomDrivaksler: { kodeNavn: "Firehjulsdrift" } },
            vekter: { egenvekt: 1957 },
            karosseriOgLasteplan: { rFarge: [{ kodeNavn: "Sølv" }], antallDorer: [6] },
            persontall: { sitteplasserTotalt: 2 },
            miljodata: {
              miljoOgdrivstoffGruppe: [
                { drivstoffKodeMiljodata: { kodeNavn: "Diesel" }, forbrukOgUtslipp: [{ co2Kombinert: 178 }] },
              ],
            },
          },
        },
      },
    },
  ],
}

describe("registry mapping", () => {
  test("extracts the EU-kontroll date the advertisement usually omits", () => {
    const facts = mapVehicle(registryResponse)!
    expect(facts.euControlDue).toBe("2027-09-30")
    expect(facts.euControlLastApproved).toBe("2025-09-12")
  })

  test("converts power from kW to hk, as Norwegian ads quote it", () => {
    expect(mapVehicle(registryResponse)!.powerHk).toBe(150) // 110 kW
  })

  test("pulls the technical facts used for valuation", () => {
    const facts = mapVehicle(registryResponse)!
    expect(facts.make).toBe("VOLKSWAGEN")
    expect(facts.modelName).toBe("TRANSPORTER")
    expect(facts.fuel).toBe("Diesel")
    expect(facts.gearbox).toBe("Automat")
    expect(facts.drivetrain).toBe("Firehjulsdrift")
    expect(facts.engineCc).toBe(1968)
    expect(facts.kerbWeightKg).toBe(1957)
    expect(facts.co2).toBe(178)
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
  test("flags a used import, which ads rarely mention", () => {
    const findings = crossCheck(mapVehicle(registryResponse)!, { mileage: 152872 })
    expect(findings.some((f) => f.includes("Bruktimportert"))).toBe(true)
  })

  test("catches a stated mileage below what was recorded at import", () => {
    // The registry is the one source the seller does not control.
    const findings = crossCheck(mapVehicle(registryResponse)!, { mileage: 80_000 })
    // nb-NO formatting uses a non-breaking space as the thousands separator.
    const normalised = findings.map((f) => f.replace(/[  ]/g, " "))
    expect(normalised.some((f) => f.includes("98 000 km"))).toBe(true)
    expect(normalised.some((f) => f.includes("80 000 km"))).toBe(true)
  })

  test("says nothing when the ad and the registry agree", () => {
    const facts = { ...mapVehicle(registryResponse)!, usedImport: false, importMileage: undefined }
    expect(crossCheck(facts, { mileage: 152872 })).toEqual([])
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
