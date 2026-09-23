import { ParseError } from "./search.ts"

// The listing detail page carries no hydration blob — it is plain server-rendered
// HTML — so this reads the spec table directly. The table is a <dl> of dt/dd
// pairs with stable Norwegian labels ("Kilometerstand", "1. gang registrert",
// "Neste frist for EU-kontroll"), which survive restyling better than class
// names do, so the labels are what we key on.

export interface ItemSpecs {
  readonly adId: number
  /** Every dt/dd pair, verbatim, so nothing is lost even when we don't model it. */
  readonly fields: Record<string, string>
  readonly description?: string
  readonly equipment: string[]
  /** Parsed out of the fields for convenience; all optional because finn's ads are inconsistent. */
  readonly regno?: string
  readonly vin?: string
  readonly firstRegistered?: string
  readonly euControlDue?: string
  readonly priceExclRegistration?: number
  readonly mileage?: number
  readonly power?: number
  readonly co2?: number
  readonly weight?: number
  readonly colour?: string
  readonly serviceHistory?: string
  readonly salesForm?: string
}

const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t ]+/g, " ")
    .trim()

/**
 * Norwegian numbers: "152 872 km", "147 447 kr", "178 g/km", "2,0 L".
 * Thin and non-breaking spaces are the usual thousands separator, and the
 * decimal comma has to go before parseFloat sees it.
 */
export function parseNorwegianNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const cleaned = raw.replace(/[  \s]/g, "").replace(/,/g, ".")
  const match = /-?\d+(?:\.\d+)?/.exec(cleaned)
  if (!match) return undefined
  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

/** Extract the dt/dd spec pairs. */
export function parseSpecFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const match of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const key = stripTags(match[1]!)
    const value = stripTags(match[2]!)
    if (key && value && !(key in fields)) fields[key] = value
  }
  return fields
}

/**
 * Equipment is a plain <ul> of short phrases. There is no stable wrapper to key
 * on, so this takes the longest list of short non-navigational items on the
 * page, which in practice is the equipment list.
 */
export function parseEquipment(html: string): string[] {
  let best: string[] = []
  for (const list of html.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/g)) {
    const items = [...list[1]!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
      .map((item) => stripTags(item[1]!))
      .filter((text) => text.length > 1 && text.length < 60 && !text.includes("\n"))
    // Navigation and breadcrumbs are lists too, but they contain links.
    const hasLinks = /<a[\s>]/.test(list[1]!)
    if (!hasLinks && items.length > best.length) best = items
  }
  return best
}

export function parseItemPage(html: string, adId: number): ItemSpecs {
  const fields = parseSpecFields(html)
  if (Object.keys(fields).length === 0)
    throw new ParseError(`No spec table found on the page for ad ${adId} — finn's detail layout has changed.`)

  const field = (...names: string[]): string | undefined => {
    for (const name of names) {
      const hit = Object.keys(fields).find((key) => key.toLowerCase().startsWith(name.toLowerCase()))
      if (hit) return fields[hit]
    }
    return undefined
  }

  return {
    adId,
    fields,
    description: parseDescription(html),
    equipment: parseEquipment(html),
    regno: field("Registreringsnummer"),
    vin: field("Chassis nr", "Understellsnummer"),
    firstRegistered: field("1. gang registrert"),
    euControlDue: field("Neste frist for EU-kontroll", "EU-kontroll"),
    priceExclRegistration: parseNorwegianNumber(field("Pris eksl")),
    mileage: parseNorwegianNumber(field("Kilometerstand")),
    power: parseNorwegianNumber(field("Effekt")),
    co2: parseNorwegianNumber(field("CO₂-utslipp", "CO2-utslipp")),
    weight: parseNorwegianNumber(field("Vekt", "Egenvekt")),
    colour: field("Farge"),
    serviceHistory: field("Servicehistorikk"),
    salesForm: field("Salgsform"),
  }
}

/**
 * The free-text ad. This is where sellers hedge — "selges som den er", "noe må
 * påregnes" — so it matters more than its length suggests, and it is what the
 * LLM pass reads alongside the photos.
 */
function parseDescription(html: string): string | undefined {
  // The description sits under a "Beskrivelse" heading; take the markup between
  // that heading and the next one.
  const start = /<h[1-6][^>]*>\s*Beskrivelse\s*<\/h[1-6]>/i.exec(html)
  if (!start) return undefined
  const rest = html.slice(start.index + start[0].length)
  const end = /<h[1-6][^>]*>/i.exec(rest)
  const text = stripTags(end ? rest.slice(0, end.index) : rest.slice(0, 20_000))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > 0 ? text : undefined
}

/**
 * finncdn serves resized variants by path substitution, which is how vision
 * cost is kept under control: 640w is ~28 KB against ~181 KB for 1600w, and is
 * plenty to see rust, panel gaps or tyre wear.
 */
export function imageVariant(url: string, size: "480w" | "640w" | "1280w" | "1600w" | "default" = "640w"): string {
  return url.replace(/\/dynamic\/[^/]+\/item\//, `/dynamic/${size}/item/`)
}
