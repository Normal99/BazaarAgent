// What you actually want in a car, as opposed to what it costs.
//
// A deal is only a deal if the car has the things you need. Someone who needs a
// towbar or seven seats does not want a bargain hatchback at the top of their
// feed, and someone who wants leather is not served by an agent that only knows
// about price.
//
// Three sources answer the question, cheapest first: finn's own equipment list
// (a plain <ul> on the detail page, and the most reliable thing available), the
// trim name in model_specification, and the free-text ad. Anything still
// unresolved goes to the model, which can also see the photographs — leather is
// often visible in an interior shot the seller never bothered to list.

export interface Requirement {
  readonly text: string
  /** A must-have disqualifies the car; a nice-to-have only adjusts the score. */
  readonly required: boolean
}

export type MatchStatus = "ja" | "nei" | "kanskje"

export interface RequirementMatch {
  readonly requirement: string
  readonly required: boolean
  readonly status: MatchStatus
  readonly evidence?: string
  readonly source: "utstyr" | "spesifikasjon" | "tekst" | "bilde" | "ukjent"
}

/**
 * Norwegian equipment vocabulary is inconsistent in ways a substring match
 * cannot bridge: a seller writes "Skinnseter", "Skinninteriør", "Skinn/alcantara"
 * or the English "Leather" for the same thing, and someone searching for
 * "hengerfeste" will miss "tilhengerfeste" and "tilhengerkrok" entirely.
 *
 * This is deliberately a small hand-written table rather than anything clever.
 * It covers what people actually ask for; the model handles the long tail.
 */
const SYNONYMS: Array<readonly string[]> = [
  ["skinn", "skinnseter", "skinninteriør", "lær", "leather", "alcantara"],
  ["hengerfeste", "tilhengerfeste", "tilhengerkrok", "hengerkrok", "tilhengerfeste avtagbart", "towbar"],
  ["ryggekamera", "ryggesensor", "backkamera", "parkeringskamera", "rear view camera", "360-kamera"],
  ["navigasjon", "navi", "gps", "kartnavigasjon"],
  ["cruisekontroll", "cruise control", "adaptiv cruise"],
  ["skyvedør", "skyvedører", "sliding door"],
  ["panorama", "panoramatak", "glasstak", "soltak", "takluke"],
  ["setervarme", "setevarme", "varme i seter", "oppvarmede seter", "heated seats"],
  ["webasto", "motorvarmer", "kupévarmer", "parkeringsvarmer", "standheizung"],
  ["firehjulsdrift", "4x4", "4wd", "awd", "4motion", "quattro", "xdrive", "4-hjulsdrift"],
  // Not "automatisk": it matches "automatisk tenning hovedlys" and half a
  // dozen other features that have nothing to do with the gearbox.
  ["automat", "automatgir", "automatgirkasse", "dsg", "s-tronic", "tiptronic"],
  ["7 seter", "7-seter", "sjuseter", "syvseter", "tredje seterad"],
  ["apple carplay", "carplay", "android auto"],
  ["el-sete", "elektrisk sete", "elektriske seter", "memory seter"],
  ["xenon", "led-lys", "ledlys", "matrix", "adaptivt lys"],
  ["klimaanlegg", "aircondition", "aircon", "klimaautomatikk", "2-soners", "3-soners"],
]

/**
 * Mentions of a requirement that do not actually mean the car has the thing.
 *
 * Norwegian equipment lists are full of trim on a feature rather than the
 * feature: "Skinnratt" and "Ratt, skinn" are a leather steering wheel, which
 * says nothing about the seats. Seen live on a 2018 Volvo V60 and a 2023 Opel
 * Vivaro, where either one satisfied a must-have for "skinn" and would have
 * sent someone to view a car with cloth seats.
 *
 * Only a mention that is EXCLUSIVELY an accessory counts as weak; "Skinnseter
 * og skinnratt" still resolves to yes.
 */
const ACCESSORY_CONTEXTS: Record<string, RegExp> = {
  // Leather on the wheel or the gear lever is not leather upholstery.
  //
  // No leading word boundary: Norwegian writes this as a compound, so the
  // accessory is the TAIL of the word — "skinnratt", not "skinn ratt". A
  // leading \b matched only the spaced form and let "Skinnratt" through.
  skinn: /(ratt|girspak|girkn[oø]tt|spak)\b/,
}

function isAccessoryOnly(requirement: string, item: string): boolean {
  const pattern = ACCESSORY_CONTEXTS[normalise(requirement)]
  if (!pattern) return false
  const text = normalise(item)
  if (!pattern.test(text)) return false
  // An entry naming the real thing as well is not accessory-only. Compound
  // tails again: "skinnseter" has no word boundary before "seter".
  return !/(sete|seter|seten|interi[oø]r|stol|stoler)\b/.test(text)
}

/**
 * Does this text contain the term, in the sense a buyer means?
 *
 * Plain `includes` is wrong in both directions here. Norwegian compounds mean
 * "skinn" must match "Skinnseter", so a strict word boundary is too tight —
 * but "automat" must NOT match "Automatisk tenning hovedlys", so raw substring
 * is too loose. The rule that separates them: the term has to start a word, and
 * must not be carrying an adjectival suffix that turns it into a different
 * concept ("automat" + "isk"). Compounds continue on a noun ("skinn" + "seter")
 * and are matched.
 */
function containsTerm(haystack: string, term: string): boolean {
  if (!term) return false
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9æøå])${escaped}(?!isk)`).test(haystack)
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[  ]/g, " ")
    .replace(/[^a-z0-9æøå+\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Every spelling worth looking for, given what the user typed.
 *
 * Group membership is decided by exact match, never by substring. The looser
 * version bled between unrelated groups: "klimaautomatikk" contains "automat",
 * so asking for an automatic gearbox pulled in the whole air-conditioning
 * group and matched "Klimaanlegg" as proof of an automatic. Seen live on a
 * 2016 Outlander.
 */
export function expand(term: string): string[] {
  const wanted = normalise(term)
  const out = new Set<string>([wanted])
  for (const group of SYNONYMS) {
    if (group.some((g) => normalise(g) === wanted)) {
      for (const g of group) out.add(normalise(g))
    }
  }
  return [...out].filter(Boolean)
}

export interface ListingText {
  readonly equipment?: readonly string[]
  readonly modelSpecification?: string | null
  readonly description?: string | null
  readonly fields?: Record<string, string>
}

/**
 * Resolve one requirement from text alone.
 *
 * Returns "kanskje" rather than "nei" when nothing matched, because absence
 * from an equipment list is weak evidence — plenty of sellers list nothing at
 * all. Deciding "nei" on silence would reject good cars, so the unresolved
 * ones are handed to the model instead.
 */
export function matchFromText(requirement: Requirement, listing: ListingText): RequirementMatch {
  const terms = expand(requirement.text)
  const base = { requirement: requirement.text, required: requirement.required }
  /** An accessory-only mention, kept in case nothing better turns up. */
  let weak: RequirementMatch | undefined

  // finn's equipment list first: it is structured, seller-curated and the most
  // reliable thing available.
  for (const item of listing.equipment ?? []) {
    if (!terms.some((t) => containsTerm(normalise(item), t))) continue
    if (isAccessoryOnly(requirement.text, item)) {
      weak ??= { ...base, status: "kanskje", evidence: `Bare «${item}» — sier ikke noe om setene`, source: "utstyr" }
      continue
    }
    return { ...base, status: "ja", evidence: item, source: "utstyr" }
  }

  const spec = normalise(listing.modelSpecification ?? "")
  if (spec && terms.some((t) => containsTerm(spec, t)))
    return { ...base, status: "ja", evidence: listing.modelSpecification!, source: "spesifikasjon" }

  for (const [key, value] of Object.entries(listing.fields ?? {})) {
    if (terms.some((t) => containsTerm(normalise(`${key} ${value}`), t)))
      return { ...base, status: "ja", evidence: `${key}: ${value}`, source: "spesifikasjon" }
  }

  // The free-text ad, quoted so the claim stays checkable.
  //
  // The quote is located in the RAW text, not the normalised copy. Normalising
  // strips punctuation and collapses whitespace, so an index taken from it
  // lands somewhere else entirely in the original — live, a match on
  // "ryggekamera" quoted a passage about towbars.
  const raw = listing.description ?? ""
  if (raw) {
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      // Same word-start rule as containsTerm, applied to the original text.
      const found = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?!isk)`, "iu").exec(raw)
      if (!found) continue
      const at = found.index + found[1]!.length
      const quote = raw
        .slice(Math.max(0, at - 40), at + term.length + 40)
        .replace(/\s+/g, " ")
        .trim()
      return { ...base, status: "ja", evidence: `…${quote}…`, source: "tekst" }
    }
  }

  // Nothing confirmed it. "kanskje" rather than "nei": absence from an
  // equipment list is weak evidence, since plenty of sellers fill in nothing,
  // and a confident "nei" on silence would discard good cars.
  return weak ?? { ...base, status: "kanskje", source: "ukjent" }
}

export function matchAll(requirements: readonly Requirement[], listing: ListingText): RequirementMatch[] {
  return requirements.map((r) => matchFromText(r, listing))
}

export interface RequirementVerdict {
  readonly matches: RequirementMatch[]
  /** A must-have that is definitely absent. */
  readonly failed: RequirementMatch[]
  /** A must-have nothing could confirm — worth asking the seller about. */
  readonly unresolved: RequirementMatch[]
  readonly metOptional: number
  readonly totalOptional: number
  /** Score adjustment: heavy for a missing must-have, mild for extras. */
  readonly scoreDelta: number
}

export function summarise(matches: readonly RequirementMatch[]): RequirementVerdict {
  const failed = matches.filter((m) => m.required && m.status === "nei")
  const unresolved = matches.filter((m) => m.required && m.status === "kanskje")
  const optional = matches.filter((m) => !m.required)
  const metOptional = optional.filter((m) => m.status === "ja").length

  // A missing must-have is close to disqualifying: the car is not the car you
  // asked for, however cheap it is. An unconfirmed one is only a caution, since
  // sellers routinely leave the equipment list empty.
  let scoreDelta = failed.length * -4 + unresolved.length * -0.5

  // Extras only count when the must-haves are intact. Letting a sunroof offset
  // a missing towbar would rank a car above one that actually does the job.
  if (failed.length === 0 && optional.length > 0) scoreDelta += (metOptional / optional.length) * 1.2

  // `-0` is a real value in JS and leaks into stored JSON as -0.
  return { matches: [...matches], failed, unresolved, metOptional, totalOptional: optional.length, scoreDelta: scoreDelta || 0 }
}

/** Parse "skinn!, hengerfeste, ryggekamera" — a trailing ! marks a must-have. */
export function parseRequirements(input: string): Requirement[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const required = part.endsWith("!")
      return { text: (required ? part.slice(0, -1) : part).trim(), required }
    })
    .filter((r) => r.text.length > 0)
}

export const formatRequirements = (requirements: readonly Requirement[]): string =>
  requirements.map((r) => `${r.text}${r.required ? "!" : ""}`).join(", ")
