import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "./paths.ts"
import type { LatLon } from "./value/distance.ts"

// Where you are, so distance means something.
//
// Stored rather than guessed, and absent by default: with no home set the
// agent simply does not score distance, which is better than quietly assuming
// Oslo and mis-ranking everything for someone who lives in Tromsø.

export interface Home extends LatLon {
  readonly label: string
  /**
   * Whether distance moves the score.
   *
   * Separate from knowing where you are, because the two are genuinely
   * different questions. Distance is always worth *showing* — a 900 km trip is
   * a fact you want on the card — but whether it should push a car down the
   * ranking is a preference. Someone happy to drive for the right car wants it
   * displayed and ignored; someone buying a runabout wants it weighted hard.
   */
  readonly scoreDistance: boolean
  /** Multiplier on the penalty, for tuning short of turning it off. 1 = default. */
  readonly weight: number
}

const HOME_PATH = () => join(stateDir, "home.json")

/**
 * Read a stored home, tolerating files written before options were added.
 *
 * Pure, so the defaulting rules can be tested without touching disk.
 */
export function parseHome(raw: unknown): Home | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Partial<Home>
  if (typeof value.lat !== "number" || typeof value.lon !== "number") return undefined
  if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) return undefined
  return {
    lat: value.lat,
    lon: value.lon,
    label: typeof value.label === "string" && value.label ? value.label : "hjemme",
    // Defaults to on: a home was set deliberately, so the obvious intent is
    // for it to count. Files written before this option existed have neither
    // field and land here.
    scoreDistance: value.scoreDistance !== false,
    weight: typeof value.weight === "number" && value.weight >= 0 ? value.weight : 1,
  }
}

export function loadHome(): Home | undefined {
  try {
    if (!existsSync(HOME_PATH())) return undefined
    return parseHome(JSON.parse(readFileSync(HOME_PATH(), "utf8")))
  } catch {
    return undefined
  }
}

export function saveHome(home: Home): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(HOME_PATH(), `${JSON.stringify(home, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Turn "Skien" or "3719" into coordinates.
 *
 * Nominatim, queried exactly once and then cached to disk forever — their
 * usage policy asks for low volume and an identifying User-Agent, and one
 * lookup per install is about as low as volume gets. A raw "lat,lon" pair is
 * accepted directly so this can be skipped entirely.
 */
export async function resolveHome(input: string): Promise<Home> {
  const pair = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input)
  if (pair)
    return { lat: Number(pair[1]), lon: Number(pair[2]), label: `${pair[1]}, ${pair[2]}`, scoreDistance: true, weight: 1 }

  const url = new URL("https://nominatim.openstreetmap.org/search")
  url.searchParams.set("q", input)
  url.searchParams.set("countrycodes", "no")
  url.searchParams.set("format", "json")
  url.searchParams.set("limit", "1")

  const response = await fetch(url, {
    headers: { "user-agent": "BazaarAgent/0.1 (personal car search; +https://github.com/Normal99/BazaarAgent)" },
  }).catch(() => undefined)
  if (!response?.ok) throw new Error(`Could not reach the geocoder to look up "${input}". Try "lat,lon" instead.`)

  const results = (await response.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>
  const hit = results[0]
  if (!hit?.lat || !hit?.lon) throw new Error(`No place in Norway matched "${input}". Try a postcode, or "lat,lon".`)

  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    label: hit.display_name?.split(",")[0]?.trim() || input,
    scoreDistance: true,
    weight: 1,
  }
}

/** Change the scoring preference without re-resolving the location. */
export function setDistanceScoring(patch: { scoreDistance?: boolean; weight?: number }): Home {
  const home = loadHome()
  if (!home) throw new Error('No home is set. Run `bazaar home "Skien"` first.')
  const next: Home = {
    ...home,
    scoreDistance: patch.scoreDistance ?? home.scoreDistance,
    weight: patch.weight ?? home.weight,
  }
  saveHome(next)
  return next
}
