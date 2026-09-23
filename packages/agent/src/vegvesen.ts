import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "./paths.ts"

// Statens vegvesen's registry, used for the one fact sellers most often leave
// out: when the car is next due for EU-kontroll. A live sweep found that field
// simply blank on plenty of ads, and a date typed by the person selling the car
// is worth less than one from the registry regardless.
//
// There are two Vegvesen hosts and picking the wrong one is a dead end:
//
//   akfell-datautlevering.atlas.vegvesen.no  → OAuth with certificate-bound
//     tokens (RFC 8705, the Maskinporten pattern). Answers every request with
//     401 unless you hold a virksomhetssertifikat tied to an organisation.
//   www.vegvesen.no/ws/.../datautlevering   → the plain `SVV-Authorization:
//     Apikey <uuid>` service individuals can actually get, 50 000 calls/day.
//
// This uses the second. The field mapping below comes from a working
// integration rather than from the docs, which are vague about the response.
//
// Deliberately NOT used: the "kjoretoyopplysninger-med-eierinformasjon"
// variant. It returns the registered owner's personal data, needs separate
// approval, and tells us nothing about what a car is worth — there is no
// reason to hold that data to haggle over a Golf.

const BASE = "https://www.vegvesen.no"
const SINGLE_LOOKUP = "/ws/no/vegvesen/kjoretoy/felles/datautlevering/enkeltoppslag/kjoretoydata"
const CONFIG = () => join(stateDir, "vegvesen.json")

export type VegvesenAuth =
  | { kind: "apikey"; key: string }
  | { kind: "bearer"; token: string }

export class VegvesenError extends Error {
  constructor(
    readonly kind: "unauthenticated" | "not_found" | "provider" | "network",
    message: string,
  ) {
    super(message)
    this.name = "VegvesenError"
  }
}

export function loadAuth(): VegvesenAuth | undefined {
  const fromEnv = process.env.VEGVESEN_API_KEY?.trim()
  if (fromEnv) return { kind: "apikey", key: fromEnv }
  const token = process.env.VEGVESEN_TOKEN?.trim()
  if (token) return { kind: "bearer", token }
  try {
    if (!existsSync(CONFIG())) return undefined
    const raw = JSON.parse(readFileSync(CONFIG(), "utf8")) as Partial<VegvesenAuth> & { kind?: string }
    if (raw.kind === "apikey" && typeof (raw as any).key === "string") return { kind: "apikey", key: (raw as any).key }
    if (raw.kind === "bearer" && typeof (raw as any).token === "string") return { kind: "bearer", token: (raw as any).token }
    return undefined
  } catch {
    return undefined
  }
}

export function saveAuth(auth: VegvesenAuth): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG(), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  chmodSync(CONFIG(), 0o600)
}

export const isConfigured = (): boolean => loadAuth() !== undefined

/** Look a vehicle up by plate or VIN. Returns undefined when not configured, so callers degrade instead of failing. */
export async function lookup(params: { regno?: string; vin?: string }, signal?: AbortSignal): Promise<unknown | undefined> {
  const auth = loadAuth()
  if (!auth) return undefined
  if (!params.regno && !params.vin) throw new VegvesenError("provider", "A plate or VIN is required.")

  const url = new URL(BASE + SINGLE_LOOKUP)
  if (params.regno) url.searchParams.set("kjennemerke", params.regno.replace(/\s+/g, "").toUpperCase())
  else url.searchParams.set("understellsnummer", params.vin!)

  const headers: Record<string, string> = { accept: "application/json" }
  if (auth.kind === "apikey") headers["SVV-Authorization"] = `Apikey ${auth.key}`
  else headers["authorization"] = `Bearer ${auth.token}`

  const response = await fetch(url, { headers, signal }).catch((error: unknown) => {
    throw new VegvesenError("network", `Could not reach Vegvesen: ${error instanceof Error ? error.message : String(error)}`)
  })

  if (response.status === 401 || response.status === 403)
    throw new VegvesenError("unauthenticated", "Vegvesen rejected the credential. Run `bazaar provider vegvesen setup` with a current API key.")
  if (response.status === 404) throw new VegvesenError("not_found", `No vehicle found for ${params.regno ?? params.vin}.`)
  if (!response.ok) throw new VegvesenError("provider", `Vegvesen returned ${response.status} ${response.statusText}.`)

  return response.json()
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/**
 * The facts worth extracting, as opposed to the several hundred the registry
 * returns. Every one of these is either a valuation input or a negotiating
 * fact, and all come from the registry rather than from the seller.
 */
export interface VehicleFacts {
  readonly regno?: string
  readonly vin?: string
  /** The date this car is next due for EU-kontroll — the field ads most often leave blank. */
  readonly euControlDue?: string
  readonly euControlLastApproved?: string
  readonly firstRegistered?: string
  readonly firstRegisteredNorway?: string
  /** True when the car was imported used, which depresses value and is rarely advertised. */
  readonly usedImport: boolean
  /** Odometer reading recorded at import, if any — something to check the ad against. */
  readonly importMileage?: number
  readonly make?: string
  readonly modelName?: string
  readonly fuel?: string
  readonly colour?: string
  readonly gearbox?: string
  readonly drivetrain?: string
  /** Converted from kW, as the registry stores it. */
  readonly powerHk?: number
  readonly engineCc?: number
  readonly kerbWeightKg?: number
  readonly co2?: number
  readonly seats?: number
  readonly doors?: number
}

const first = <T>(value: T[] | undefined): T | undefined => (Array.isArray(value) ? value[0] : undefined)

/** Map one registry response into the facts we use. Tolerant: the registry omits plenty per vehicle. */
export function mapVehicle(raw: unknown): VehicleFacts | undefined {
  const kd = first((raw as { kjoretoydataListe?: any[] })?.kjoretoydataListe)
  if (!kd) return undefined

  const godkjenning = kd.godkjenning ?? {}
  const tekniske = godkjenning.tekniskGodkjenning?.tekniskeData ?? {}
  const generelt = tekniske.generelt ?? {}
  const motor = first<any>(tekniske.motorOgDrivverk?.motor) ?? {}
  const miljo = first<any>(tekniske.miljodata?.miljoOgdrivstoffGruppe) ?? {}
  const bruktimport = godkjenning.forstegangsGodkjenning?.bruktimport

  const powerKw = Number(motor.maksNettoEffekt)

  return {
    regno: kd.kjoretoyId?.kjennemerke,
    vin: kd.kjoretoyId?.understellsnummer,
    euControlDue: kd.periodiskKjoretoyKontroll?.kontrollfrist,
    euControlLastApproved: kd.periodiskKjoretoyKontroll?.sistGodkjent,
    firstRegistered: godkjenning.forstegangsGodkjenning?.forstegangRegistrertDato,
    firstRegisteredNorway: kd.forstegangsregistrering?.registrertForstegangNorgeDato,
    usedImport: Boolean(bruktimport),
    importMileage: Number.isFinite(Number(bruktimport?.kilometerstand)) ? Number(bruktimport.kilometerstand) : undefined,
    make: first<any>(generelt.merke)?.merke,
    modelName: first<string>(generelt.handelsbetegnelse),
    fuel: miljo.drivstoffKodeMiljodata?.kodeNavn,
    colour: first<any>(tekniske.karosseriOgLasteplan?.rFarge)?.kodeNavn,
    gearbox: tekniske.motorOgDrivverk?.girkassetype?.kodeNavn,
    drivetrain: tekniske.akslinger?.forbindelseMellomDrivaksler?.kodeNavn,
    powerHk: Number.isFinite(powerKw) ? Math.round(powerKw * 1.36) : undefined,
    engineCc: Number(motor.slagvolum) || undefined,
    kerbWeightKg: Number(tekniske.vekter?.egenvekt) || undefined,
    co2: Number(first<any>(miljo.forbrukOgUtslipp)?.co2Kombinert) || undefined,
    seats: Number(tekniske.persontall?.sitteplasserTotalt) || undefined,
    doors: Number(first<any>(tekniske.karosseriOgLasteplan?.antallDorer)) || undefined,
  }
}

/**
 * Cross-check the registry against the advertisement.
 *
 * The registry is the one source the seller does not control, so a
 * disagreement here is worth more than anything in the ad text. A used import
 * that the ad never mentions, or a stated mileage below what was recorded at
 * import, is both a red flag and a negotiating lever.
 */
export function crossCheck(facts: VehicleFacts, ad: { mileage?: number; year?: number }): string[] {
  const findings: string[] = []
  if (facts.usedImport) findings.push("Bruktimportert ifølge registeret — påvirker verdi og er sjelden nevnt i annonsen.")
  if (facts.importMileage !== undefined && ad.mileage !== undefined && ad.mileage < facts.importMileage)
    findings.push(`Annonsen oppgir ${ad.mileage.toLocaleString("nb-NO")} km, men ved import var kilometerstanden ${facts.importMileage.toLocaleString("nb-NO")} km.`)
  return findings
}

// ---------------------------------------------------------------------------
// EU-kontroll without the registry
// ---------------------------------------------------------------------------

export interface EuControlEstimate {
  readonly dueYear: number
  /** "registry" once a real lookup backs it; "inferred" while it is only the rule. */
  readonly source: "inferred"
  readonly note: string
}

/**
 * Norwegian PKK schedule, applied to a first-registration date.
 *
 * A passenger car's first inspection falls in the fourth calendar year after
 * registration, and every second year after that. This is a rule, not a
 * lookup, so it is wrong for vans, imports and re-registered vehicles — hence
 * the explicit `source` marker, so the UI can say "beregnet" rather than
 * presenting a guess with the authority of a registry hit.
 */
export function inferEuControl(firstRegistered: string | undefined, currentYear = new Date().getFullYear()): EuControlEstimate | undefined {
  if (!firstRegistered) return undefined
  // finn renders this as dd.mm.yyyy.
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(firstRegistered)
  const year = match ? Number(match[3]) : Number(/(\d{4})/.exec(firstRegistered)?.[1])
  if (!Number.isFinite(year) || year < 1950 || year > currentYear + 1) return undefined

  let due = year + 4
  while (due < currentYear) due += 2

  return {
    dueYear: due,
    source: "inferred",
    note: `Beregnet fra første registrering ${year} (første kontroll år 4, deretter hvert 2. år). Ikke bekreftet mot registeret.`,
  }
}
