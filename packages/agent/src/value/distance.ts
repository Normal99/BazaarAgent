// How far away the car is, which decides whether a deal is a deal.
//
// Every listing carries coordinates and they have been ignored until now, with
// predictable results: a Transporter in Kongsfjord scored well on price while
// sitting roughly 1 800 km from Telemark. Distance is not a tiebreaker here,
// it is part of the cost — a 600 km round trip is fuel, a day, and a much
// weaker position if you find a fault when you arrive.

export interface LatLon {
  readonly lat: number
  readonly lon: number
}

const EARTH_RADIUS_KM = 6371
const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * Great-circle distance.
 *
 * Deliberately not road distance. Norway's geography means driving can be far
 * longer than the straight line — fjords, mountains, ferries — so this
 * understates the trip, sometimes badly. It is used as a lower bound and a
 * ranking signal, never presented as "how far you will drive".
 */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface TravelCost {
  readonly straightLineKm: number
  /** Rough road distance: the straight line with a detour factor applied. */
  readonly roadKm: number
  /** Return trip, in kroner. */
  readonly costNok: number
  /** Return trip driving time, hours. */
  readonly hours: number
  readonly note: string
}

/**
 * Norwegian roads are not straight. A factor of 1.35 is a reasonable national
 * average for mainland driving; it is still optimistic along the west coast
 * and in the north, which the note says out loud rather than hiding.
 */
const DETOUR_FACTOR = 1.35
/** Fuel plus wear, per km, one way. Conservative. */
const COST_PER_KM = 3.5
const AVERAGE_SPEED_KMH = 70

export function travelCost(home: LatLon, car: LatLon): TravelCost {
  const straightLineKm = haversineKm(home, car)
  const roadKm = straightLineKm * DETOUR_FACTOR
  const returnKm = roadKm * 2
  return {
    straightLineKm,
    roadKm,
    costNok: returnKm * COST_PER_KM,
    hours: returnKm / AVERAGE_SPEED_KMH,
    note:
      straightLineKm > 400
        ? "Luftlinje — faktisk kjørerute kan være vesentlig lengre, særlig langs kysten og nordover."
        : "Omtrentlig kjøreavstand.",
  }
}

/**
 * Score adjustment for distance.
 *
 * Nothing within an hour or so; a real penalty beyond a day trip. The point is
 * not to rule distant cars out — a genuinely exceptional car is worth the
 * drive — but to stop a marginally cheaper car 900 km away outranking an
 * equivalent one nearby.
 */
export function distancePenalty(roadKm: number): { delta: number; label: string } {
  if (roadKm < 60) return { delta: 0.4, label: "i nærheten" }
  if (roadKm < 150) return { delta: 0, label: `${Math.round(roadKm)} km unna` }
  if (roadKm < 350) return { delta: -0.4, label: `${Math.round(roadKm)} km unna` }
  if (roadKm < 700) return { delta: -1.1, label: `${Math.round(roadKm)} km — dagstur` }
  return { delta: -2.2, label: `${Math.round(roadKm)} km — langt unna` }
}
