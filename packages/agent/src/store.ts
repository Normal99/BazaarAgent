import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { databasePath } from "./paths.ts"
import type { SearchEntry } from "./finn/types.ts"
import type { ItemSpecs } from "./finn/item.ts"
import type { CallRecord } from "llm-brain"
import type { Requirement } from "./value/requirements.ts"
import { classifyListing, isMarketEvidence, type ListingType } from "./finn/listing-type.ts"

// SQLite because the whole point is a local-first agent that survives a reboot
// and can be inspected with a shell. WAL so a sweep writing does not block the
// web UI reading.

export type Change =
  | { kind: "new"; entry: SearchEntry }
  | { kind: "price"; entry: SearchEntry; previous: number }
  /** Same VIN, new ad id: the car did not sell and was reposted. */
  | { kind: "relisted"; entry: SearchEntry; previousAdId: number; previousPrice: number; daysBetween: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL UNIQUE,
  budget_nok   INTEGER,
  min_score    REAL NOT NULL DEFAULT 6,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_swept   INTEGER
);

CREATE TABLE IF NOT EXISTS listings (
  ad_id           INTEGER PRIMARY KEY,
  vin             TEXT,
  regno           TEXT,
  heading         TEXT NOT NULL,
  url             TEXT NOT NULL,
  make            TEXT,
  model           TEXT,
  series          TEXT,
  spec            TEXT,
  year            INTEGER,
  mileage         INTEGER,
  price           INTEGER NOT NULL,
  fuel            TEXT,
  transmission    TEXT,
  dealer_segment  TEXT,
  org_id          TEXT,
  org_name        TEXT,
  location        TEXT,
  lat             REAL,
  lon             REAL,
  registration_class TEXT,
  published_at    INTEGER,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  delisted_at     INTEGER,
  image_urls      TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_vin       ON listings(vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS listings_model     ON listings(make, model, year);
CREATE INDEX IF NOT EXISTS listings_live      ON listings(delisted_at) WHERE delisted_at IS NULL;

CREATE TABLE IF NOT EXISTS specs (
  ad_id          INTEGER PRIMARY KEY REFERENCES listings(ad_id),
  description    TEXT,
  equipment_json TEXT,
  fields_json    TEXT,
  eu_control_due TEXT,
  first_registered TEXT,
  price_excl_reg INTEGER,
  fetched_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vegvesen (
  vin        TEXT PRIMARY KEY,
  regno      TEXT,
  fetched_at INTEGER NOT NULL,
  data_json  TEXT NOT NULL
);

-- Deliberately not keyed on (ad_id, observed_at): two price observations can
-- land in the same millisecond, and a composite key silently discards the
-- second one. Rows are only written when the price actually changes, so there
-- is nothing to deduplicate and a surrogate key is the honest choice.
CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id       INTEGER NOT NULL REFERENCES listings(ad_id),
  observed_at INTEGER NOT NULL,
  price       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_ad ON price_history(ad_id, observed_at);

CREATE TABLE IF NOT EXISTS valuations (
  ad_id        INTEGER PRIMARY KEY REFERENCES listings(ad_id),
  computed_at  INTEGER NOT NULL,
  fair_value   INTEGER,
  residual_pct REAL,
  comp_count   INTEGER NOT NULL,
  score        REAL,
  model_json   TEXT
);

CREATE TABLE IF NOT EXISTS analyses (
  ad_id            INTEGER PRIMARY KEY REFERENCES listings(ad_id),
  flags_json       TEXT NOT NULL,
  levers_json      TEXT NOT NULL,
  odometer_seen_km INTEGER,
  images_used_json TEXT,
  summary          TEXT,
  provider         TEXT NOT NULL,
  computed_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  task            TEXT NOT NULL,
  ad_id           INTEGER,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  ok              INTEGER NOT NULL,
  escalate_reason TEXT,
  latency_ms      INTEGER NOT NULL,
  attempt         INTEGER NOT NULL,
  image_count     INTEGER NOT NULL DEFAULT 0,
  detail          TEXT
);
CREATE INDEX IF NOT EXISTS llm_calls_task ON llm_calls(task, ts);

CREATE TABLE IF NOT EXISTS notified (
  ad_id   INTEGER NOT NULL,
  reason  TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (ad_id, reason)
);

-- Which search turned up which listing. Requirements belong to a search, so a
-- must-have on the Tiguan hunt must not quietly disqualify every car found by
-- a different search. Corpus sweeps deliberately record nothing here: they are
-- price discovery, not deal hunting, and carry no wishlist.
CREATE TABLE IF NOT EXISTS listing_searches (
  ad_id     INTEGER NOT NULL,
  search_id INTEGER NOT NULL,
  PRIMARY KEY (ad_id, search_id)
);

CREATE TABLE IF NOT EXISTS watchlist (
  ad_id    INTEGER PRIMARY KEY REFERENCES listings(ad_id),
  added_at INTEGER NOT NULL,
  note     TEXT
);
`

export interface CompRow {
  readonly ad_id: number
  readonly year: number
  readonly mileage: number
  readonly price: number
  readonly fuel: string | null
  readonly transmission: string | null
  readonly dealer_segment: string | null
  readonly model: string | null
  readonly series: string | null
}

export interface SearchRow {
  readonly id: number
  readonly name: string
  readonly url: string
  readonly budget_nok: number | null
  readonly min_score: number
  readonly last_swept: number | null
  readonly requirements_json: string | null
}

/** Requirements stored against a search, tolerating a row written before the column existed. */
export function parseSearchRequirements(search: { requirements_json?: string | null }): Requirement[] {
  if (!search.requirements_json) return []
  try {
    const parsed = JSON.parse(search.requirements_json)
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.text === "string") : []
  } catch {
    return []
  }
}

export interface ListingRow {
  readonly ad_id: number
  readonly heading: string
  readonly url: string
  readonly make: string | null
  readonly model: string | null
  readonly series: string | null
  readonly year: number
  readonly mileage: number
  readonly price: number
  readonly fuel: string | null
  readonly transmission: string | null
  readonly dealer_segment: string | null
  readonly location: string | null
  readonly lat: number | null
  readonly lon: number | null
  readonly published_at: number | null
  readonly image_urls: string | null
  readonly regno: string | null
  readonly vin: string | null
  readonly listing_type: string | null
}

export interface DealRow {
  readonly ad_id: number
  readonly heading: string
  readonly url: string
  readonly year: number | null
  readonly mileage: number | null
  readonly price: number
  readonly dealer_segment: string | null
  readonly location: string | null
  readonly listing_type: string | null
  readonly fair_value: number | null
  readonly residual_pct: number | null
  readonly comp_count: number
  readonly score: number | null
  readonly model_json: string | null
  readonly condition: string | null
  readonly project_json: string | null
  readonly summary: string | null
  readonly levers_json: string | null
  readonly flags_json: string | null
  readonly provider: string | null
}

export interface PriceDrop {
  readonly ad_id: number
  readonly heading: string
  readonly url: string
  readonly price: number
  readonly previous_price: number
  readonly changed_at: number
  readonly location: string | null
  readonly year: number | null
  readonly mileage: number | null
  readonly score: number | null
  readonly fair_value: number | null
  readonly watched: number
}

export interface SweepResult {
  readonly seen: number
  readonly changes: Change[]
  readonly delisted: number[]
}

export class Store {
  readonly db: Database

  constructor(path: string = databasePath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * Add columns to a database that already exists.
   *
   * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
   * so new columns need adding explicitly. Checking pragma table_info first
   * keeps this idempotent without needing a version counter.
   */
  private migrate(): void {
    const columns = (table: string) =>
      new Set((this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))

    const add = (table: string, column: string, definition: string) => {
      if (!columns(table).has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }

    add("searches", "requirements_json", "TEXT")
    add("listings", "listing_type", "TEXT")
    add("valuations", "condition", "TEXT")
    add("valuations", "project_json", "TEXT")
    this.db.exec(`CREATE TABLE IF NOT EXISTS listing_searches (
      ad_id INTEGER NOT NULL, search_id INTEGER NOT NULL, PRIMARY KEY (ad_id, search_id))`)

    // Backfill from the payload already stored, so an existing database stops
    // valuing lease payments as purchase prices without needing a re-sweep.
    const unclassified = this.db.query<{ ad_id: number; raw_json: string }, []>(
      "SELECT ad_id, raw_json FROM listings WHERE listing_type IS NULL",
    ).all()
    if (unclassified.length > 0) {
      const set = this.db.query("UPDATE listings SET listing_type = ? WHERE ad_id = ?")
      this.db.transaction(() => {
        for (const row of unclassified) {
          let type: ListingType = "other"
          try {
            type = classifyListing(JSON.parse(row.raw_json))
          } catch {
            // A row we cannot parse stays "other" and is kept out of the comps.
          }
          set.run(type, row.ad_id)
        }
      })()
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS listings_type ON listings(listing_type)")
    add("analyses", "requirements_json", "TEXT")
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Searches
  // -------------------------------------------------------------------------

  addSearch(name: string, url: string, budget?: number, minScore = 6, requirements?: readonly Requirement[]): number {
    const row = this.db
      .query<{ id: number }, [string, string, number | null, number, string | null, number]>(
        `INSERT INTO searches (name, url, budget_nok, min_score, requirements_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET name = excluded.name, budget_nok = excluded.budget_nok,
           min_score = excluded.min_score, requirements_json = excluded.requirements_json
         RETURNING id`,
      )
      .get(name, url, budget ?? null, minScore, requirements?.length ? JSON.stringify(requirements) : null, Date.now())
    return row!.id
  }

  listSearches(activeOnly = true): SearchRow[] {
    return this.db
      .query<SearchRow, []>(
        `SELECT id, name, url, budget_nok, min_score, last_swept, requirements_json
         FROM searches ${activeOnly ? "WHERE active = 1" : ""} ORDER BY id`,
      )
      .all()
  }

  /**
   * The requirements that apply to one listing.
   *
   * Only the searches that actually turned this car up, so a wishlist written
   * for one hunt never judges a car found by another. A car matched by two
   * searches gets the union, and a must-have in either wins — if you need a
   * towbar on one hunt, a car without one still is not what you asked for.
   */
  requirementsFor(adId: number): Requirement[] {
    const rows = this.db
      .query<SearchRow, [number]>(
        `SELECT s.id, s.name, s.url, s.budget_nok, s.min_score, s.last_swept, s.requirements_json
         FROM searches s JOIN listing_searches ls ON ls.search_id = s.id
         WHERE ls.ad_id = ? AND s.active = 1`,
      )
      .all(adId)

    const seen = new Map<string, Requirement>()
    for (const row of rows) {
      for (const requirement of parseSearchRequirements(row)) {
        const key = requirement.text.toLowerCase()
        const existing = seen.get(key)
        if (!existing || (requirement.required && !existing.required)) seen.set(key, requirement)
      }
    }
    return [...seen.values()]
  }

  /**
   * Remove a search entirely.
   *
   * The listings it found are kept: they are market data, and throwing away
   * comparables because you renamed a hunt would quietly degrade every
   * valuation. Only the link rows go, so the search's requirements stop being
   * applied to the cars it happened to turn up.
   */
  deleteSearch(id: number): boolean {
    const removed = this.db.transaction(() => {
      this.db.query("DELETE FROM listing_searches WHERE search_id = ?").run(id)
      return this.db.query("DELETE FROM searches WHERE id = ?").run(id).changes > 0
    })()
    return removed
  }

  /** Stop or resume sweeping a search without losing how it was set up. */
  setSearchActive(id: number, active: boolean): boolean {
    return this.db.query("UPDATE searches SET active = ? WHERE id = ?").run(active ? 1 : 0, id).changes > 0
  }

  getSearch(id: number): SearchRow | null {
    return this.db
      .query<SearchRow, [number]>(
        "SELECT id, name, url, budget_nok, min_score, last_swept, requirements_json FROM searches WHERE id = ?",
      )
      .get(id)
  }

  /** Which searches turned up each listing, for filtering a mixed feed. */
  searchIdsByListing(): Map<number, number[]> {
    const map = new Map<number, number[]>()
    for (const row of this.db.query<{ ad_id: number; search_id: number }, []>("SELECT ad_id, search_id FROM listing_searches").all()) {
      const existing = map.get(row.ad_id)
      if (existing) existing.push(row.search_id)
      else map.set(row.ad_id, [row.search_id])
    }
    return map
  }

  markSwept(searchId: number): void {
    this.db.query("UPDATE searches SET last_swept = ? WHERE id = ?").run(Date.now(), searchId)
  }

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  /**
   * Fold a sweep's results into the database and report what actually changed.
   *
   * This is where the agent earns its keep: a human scrolling finn sees a wall
   * of cars and no history. Here, a car that came back cheaper under a new ad
   * id, or quietly dropped 15 000 kr last Tuesday, is a fact on record.
   */
  ingest(entries: readonly SearchEntry[], searchId?: number): Change[] {
    const now = Date.now()
    const changes: Change[] = []

    const existing = this.db.query<{ ad_id: number; price: number; vin: string | null }, [number]>(
      "SELECT ad_id, price, vin FROM listings WHERE ad_id = ?",
    )
    // Same listing_type on both sides: the same VIN very often appears once
    // for sale and once to lease, which is one car advertised two ways rather
    // than a car that failed to sell. Comparing across types reported those as
    // relists and invented a price drop from 288 000 kr to 3 789 kr.
    const byVin = this.db.query<{ ad_id: number; price: number; first_seen: number }, [string, string, number]>(
      `SELECT ad_id, price, first_seen FROM listings
       WHERE vin = ? AND listing_type = ? AND ad_id != ? ORDER BY last_seen DESC LIMIT 1`,
    )

    const upsert = this.db.query(
      `INSERT INTO listings (
         ad_id, vin, regno, heading, url, make, model, series, spec, year, mileage, price,
         fuel, transmission, dealer_segment, org_id, org_name, location, lat, lon,
         registration_class, published_at, first_seen, last_seen, image_urls, raw_json, listing_type
       ) VALUES (
         $ad_id, $vin, $regno, $heading, $url, $make, $model, $series, $spec, $year, $mileage, $price,
         $fuel, $transmission, $dealer_segment, $org_id, $org_name, $location, $lat, $lon,
         $registration_class, $published_at, $now, $now, $image_urls, $raw_json, $listing_type
       )
       ON CONFLICT(ad_id) DO UPDATE SET
         price = excluded.price, mileage = excluded.mileage, last_seen = excluded.last_seen,
         heading = excluded.heading, raw_json = excluded.raw_json, delisted_at = NULL`,
    )
    const addPrice = this.db.query("INSERT INTO price_history (ad_id, observed_at, price) VALUES (?, ?, ?)")
    const link = this.db.query("INSERT OR IGNORE INTO listing_searches (ad_id, search_id) VALUES (?, ?)")

    const transaction = this.db.transaction((rows: readonly SearchEntry[]) => {
      for (const entry of rows) {
        const previous = existing.get(entry.ad_id)
        const price = entry.price.amount

        // Only actual changes go into price_history. Writing a row per listing
        // per sweep would grow without bound and, since sweeps minutes apart
        // share a timestamp granularity, silently collide on the primary key.
        const priceIsNews = !previous || previous.price !== price

        if (!previous) {
          // A VIN we have seen under a different ad id means the seller relisted
          // rather than sold — invisible on finn, and the strongest leverage there is.
          const prior = entry.chassis_number ? byVin.get(entry.chassis_number, classifyListing(entry), entry.ad_id) : undefined
          if (prior) {
            changes.push({
              kind: "relisted",
              entry,
              previousAdId: prior.ad_id,
              previousPrice: prior.price,
              daysBetween: Math.round((now - prior.first_seen) / 86_400_000),
            })
          } else {
            changes.push({ kind: "new", entry })
          }
        } else if (previous.price !== price) {
          changes.push({ kind: "price", entry, previous: previous.price })
        }

        upsert.run({
          $ad_id: entry.ad_id,
          $vin: entry.chassis_number ?? null,
          $regno: entry.regno ?? null,
          $heading: entry.heading,
          $url: entry.canonical_url,
          $make: entry.make ?? null,
          $model: entry.model ?? null,
          $series: entry.series ?? null,
          $spec: entry.model_specification ?? null,
          $year: entry.year ?? null,
          $mileage: entry.mileage ?? null,
          $price: price,
          $fuel: entry.fuel ?? null,
          $transmission: entry.transmission ?? null,
          $dealer_segment: entry.dealer_segment ?? null,
          $org_id: entry.org_id ?? null,
          $org_name: entry.organisation_name ?? null,
          $location: entry.location ?? null,
          $lat: entry.coordinates?.lat ?? null,
          $lon: entry.coordinates?.lon ?? null,
          $registration_class: entry.registration_class?.value ?? null,
          $published_at: entry.timestamp ?? null,
          $now: now,
          $image_urls: JSON.stringify(entry.image_urls ?? []),
          $raw_json: JSON.stringify(entry),
          $listing_type: classifyListing(entry),
        })
        if (priceIsNews) addPrice.run(entry.ad_id, now, price)
        if (searchId !== undefined) link.run(entry.ad_id, searchId)
      }
    })

    transaction(entries)
    return changes
  }

  /**
   * Mark listings that were in scope last time but absent now.
   *
   * Only safe to call with the full set of ad ids a sweep covered — a listing
   * missing from page 1 has usually just been pushed down, not sold, so this
   * takes the ids the caller actually looked at rather than guessing.
   */
  markDelisted(seenAdIds: readonly number[], candidateAdIds: readonly number[]): number[] {
    if (candidateAdIds.length === 0) return []
    const seen = new Set(seenAdIds)
    const gone = candidateAdIds.filter((id) => !seen.has(id))
    if (gone.length === 0) return []
    const mark = this.db.query("UPDATE listings SET delisted_at = ? WHERE ad_id = ? AND delisted_at IS NULL")
    const now = Date.now()
    this.db.transaction(() => {
      for (const id of gone) mark.run(now, id)
    })()
    return gone
  }

  saveSpecs(specs: ItemSpecs): void {
    this.db
      .query(
        `INSERT INTO specs (ad_id, description, equipment_json, fields_json, eu_control_due, first_registered, price_excl_reg, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ad_id) DO UPDATE SET
           description = excluded.description, equipment_json = excluded.equipment_json,
           fields_json = excluded.fields_json, eu_control_due = excluded.eu_control_due,
           first_registered = excluded.first_registered, price_excl_reg = excluded.price_excl_reg,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        specs.adId,
        specs.description ?? null,
        JSON.stringify(specs.equipment),
        JSON.stringify(specs.fields),
        specs.euControlDue ?? null,
        specs.firstRegistered ?? null,
        specs.priceExclRegistration ?? null,
        Date.now(),
      )
  }

  /** Listings we have never fetched a detail page for. */
  needingSpecs(limit = 25): Array<{ ad_id: number; url: string }> {
    return this.db
      .query<{ ad_id: number; url: string }, [number]>(
        `SELECT l.ad_id, l.url FROM listings l
         LEFT JOIN specs s ON s.ad_id = l.ad_id
         WHERE s.ad_id IS NULL AND l.delisted_at IS NULL
         ORDER BY l.first_seen DESC LIMIT ?`,
      )
      .all(limit)
  }

  priceHistory(adId: number): Array<{ observed_at: number; price: number }> {
    return this.db
      .query<{ observed_at: number; price: number }, [number]>(
        "SELECT observed_at, price FROM price_history WHERE ad_id = ? ORDER BY observed_at, id",
      )
      .all(adId)
  }

  /**
   * Candidate comparables, filtered as tightly as the caller asks.
   *
   * The grouping fields are subtler than they look, and live data settles it:
   * `model` carries the *generation* ("Golf VII", "Golf VI", "e-Golf VII",
   * "Golf Sportsvan"), so matching on it alone splinters 32 Golfs into groups
   * of 10/8/7/5/1/1 — mostly too small to value against. `series` ("Golf-Serie")
   * reunites them, but over-groups: it puts the electric e-Golf, the Sportsvan
   * body style and a 1980s Golf II in with a 2018 petrol hatchback. It is also
   * simply null for some models (Amarok, ID.3, Multivan, Sharan).
   *
   * So neither field alone works. comps.ts walks a ladder from narrow to wide
   * using both; this just executes whichever rung it is on. Fuel is a parameter
   * rather than an assumption because it is the one dimension that must never
   * be widened away.
   */
  comparables(filter: {
    make: string
    /** Generation, e.g. "Golf VII". Omit to group by series instead. */
    model?: string
    /** e.g. "Golf-Serie". Used when model is omitted. */
    series?: string
    yearFrom: number
    yearTo: number
    fuel?: string
    transmission?: string
    /** Exclude the car being valued. */
    excludeAdId?: number
  }): CompRow[] {
    const where: string[] = [
      "make = ?",
      "year BETWEEN ? AND ?",
      "mileage IS NOT NULL",
      "year IS NOT NULL",
      "price > 0",
      "delisted_at IS NULL",
      // Only an actual asking price is evidence of what the market pays. A
      // monthly lease payment and an auction starting bid are both numbers in
      // the same column meaning something else entirely.
      "listing_type = 'sale'",
    ]
    const params: Array<string | number> = [filter.make, filter.yearFrom, filter.yearTo]

    if (filter.model) {
      where.push("model = ?")
      params.push(filter.model)
    } else if (filter.series) {
      where.push("series = ?")
      params.push(filter.series)
    }
    if (filter.fuel) {
      where.push("fuel = ?")
      params.push(filter.fuel)
    }
    if (filter.transmission) {
      where.push("transmission = ?")
      params.push(filter.transmission)
    }
    if (filter.excludeAdId !== undefined) {
      where.push("ad_id != ?")
      params.push(filter.excludeAdId)
    }

    return this.db
      .query<CompRow, (string | number)[]>(
        `SELECT ad_id, year, mileage, price, fuel, transmission, dealer_segment, model, series
         FROM listings WHERE ${where.join(" AND ")} ORDER BY year DESC`,
      )
      .all(...params)
  }

  // -------------------------------------------------------------------------
  // Valuations and analyses
  // -------------------------------------------------------------------------

  saveValuation(
    adId: number,
    v: { fairValue: number; residualPct: number; compCount: number; score: number; model: unknown; condition?: string; project?: unknown },
  ): void {
    this.db
      .query(
        `INSERT INTO valuations (ad_id, computed_at, fair_value, residual_pct, comp_count, score, model_json, condition, project_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ad_id) DO UPDATE SET computed_at=excluded.computed_at, fair_value=excluded.fair_value,
           residual_pct=excluded.residual_pct, comp_count=excluded.comp_count, score=excluded.score,
           model_json=excluded.model_json, condition=excluded.condition, project_json=excluded.project_json`,
      )
      .run(
        adId,
        Date.now(),
        Math.round(v.fairValue),
        v.residualPct,
        v.compCount,
        v.score,
        JSON.stringify(v.model),
        v.condition ?? "running",
        v.project ? JSON.stringify(v.project) : null,
      )
  }

  saveAnalysis(adId: number, a: { flags: unknown; levers: unknown; odometerSeenKm?: number | null; imagesUsed: string[]; summary: string; provider: string; requirements?: unknown }): void {
    this.db
      .query(
        `INSERT INTO analyses (ad_id, flags_json, levers_json, odometer_seen_km, images_used_json, summary, provider, computed_at, requirements_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ad_id) DO UPDATE SET flags_json=excluded.flags_json, levers_json=excluded.levers_json,
           odometer_seen_km=excluded.odometer_seen_km, images_used_json=excluded.images_used_json,
           summary=excluded.summary, provider=excluded.provider, computed_at=excluded.computed_at,
           requirements_json=excluded.requirements_json`,
      )
      .run(
        adId,
        JSON.stringify(a.flags),
        JSON.stringify(a.levers),
        a.odometerSeenKm ?? null,
        JSON.stringify(a.imagesUsed),
        a.summary,
        a.provider,
        Date.now(),
        a.requirements ? JSON.stringify(a.requirements) : null,
      )
  }

  hasAnalysis(adId: number): boolean {
    return this.db.query("SELECT 1 FROM analyses WHERE ad_id = ?").get(adId) !== null
  }

  /** Live listings with everything needed to value them, newest first. */
  valuationCandidates(limit = 500): ListingRow[] {
    return this.db
      .query<ListingRow, [number]>(
        `SELECT ad_id, heading, url, make, model, series, year, mileage, price, fuel, transmission,
                dealer_segment, location, lat, lon, published_at, image_urls, regno, vin, listing_type
         FROM listings
         WHERE delisted_at IS NULL AND year IS NOT NULL AND mileage IS NOT NULL AND price > 0
           AND listing_type IN ('sale', 'auction')
         ORDER BY first_seen DESC LIMIT ?`,
      )
      .all(limit)
  }

  listing(adId: number): ListingRow | null {
    return this.db
      .query<ListingRow, [number]>(
        `SELECT ad_id, heading, url, make, model, series, year, mileage, price, fuel, transmission,
                dealer_segment, location, lat, lon, published_at, image_urls, regno, vin, listing_type
         FROM listings WHERE ad_id = ?`,
      )
      .get(adId)
  }

  specs(adId: number): { description: string | null; equipment_json: string | null; fields_json: string | null; eu_control_due: string | null; price_excl_reg: number | null } | null {
    return this.db
      .query<any, [number]>("SELECT description, equipment_json, fields_json, eu_control_due, price_excl_reg FROM specs WHERE ad_id = ?")
      .get(adId)
  }

  /** Scored listings worth looking at, best first. */
  topDeals(limit = 20, minScore = 0): DealRow[] {
    return this.db
      .query<DealRow, [number, number]>(
        `SELECT l.ad_id, l.heading, l.url, l.year, l.mileage, l.price, l.dealer_segment, l.location,
                l.listing_type,
                v.fair_value, v.residual_pct, v.comp_count, v.score, v.model_json, v.condition, v.project_json,
                a.summary, a.levers_json, a.flags_json, a.provider
         FROM listings l
         JOIN valuations v ON v.ad_id = l.ad_id
         LEFT JOIN analyses a ON a.ad_id = l.ad_id
         WHERE l.delisted_at IS NULL AND v.score >= ? AND l.listing_type IN ('sale', 'auction')
         ORDER BY v.score DESC LIMIT ?`,
      )
      .all(minScore, limit)
  }

  /** Whether this was already delivered. Separate from recording a delivery. */
  wasNotified(adId: number, reason: string): boolean {
    return this.db.query("SELECT 1 FROM notified WHERE ad_id = ? AND reason = ?").get(adId, reason) !== null
  }

  /**
   * An earlier advert for the same car, if there is one.
   *
   * Same VIN, same listing type, different ad: the car was put up, did not
   * sell, and was posted again. finn shows no trace of this and it is among
   * the strongest things you can know walking into a negotiation.
   */
  relistOf(adId: number): { ad_id: number; price: number; first_seen: number; delisted_at: number | null } | null {
    return this.db
      .query<{ ad_id: number; price: number; first_seen: number; delisted_at: number | null }, [number, number]>(
        `SELECT prev.ad_id, prev.price, prev.first_seen, prev.delisted_at
         FROM listings cur
         JOIN listings prev
           ON prev.vin = cur.vin
          AND prev.listing_type = cur.listing_type
          AND prev.ad_id <> cur.ad_id
          AND prev.first_seen < cur.first_seen
         WHERE cur.ad_id = ? AND cur.vin IS NOT NULL AND prev.vin IS NOT NULL AND ? IS NOT NULL
         ORDER BY prev.first_seen DESC LIMIT 1`,
      )
      .get(adId, adId)
  }

  /**
   * Ad ids that are a repost of an earlier advert, for decorating a whole feed.
   *
   * A window function rather than a self-join, and the difference is not
   * academic: the join version took 35.7 seconds on 3800 listings and hung the
   * web UI. SQLite could not use the partial `listings_vin` index for the
   * joined side, because that index is declared WHERE vin IS NOT NULL and the
   * join never constrained prev.vin — so it fell back to a full scan per row.
   * This is one pass and a sort.
   */
  relistedAdIds(): Set<number> {
    const rows = this.db
      .query<{ ad_id: number }, []>(
        `SELECT ad_id FROM (
           SELECT ad_id, delisted_at,
                  ROW_NUMBER() OVER (PARTITION BY vin, listing_type ORDER BY first_seen, ad_id) AS seq
           FROM listings WHERE vin IS NOT NULL
         ) WHERE seq > 1 AND delisted_at IS NULL`,
      )
      .all()
    return new Set(rows.map((r) => r.ad_id))
  }

/**
   * Listings whose price has come down since we last saw it.
   *
   * A seller cutting their price is telling you something about their floor,
   * and it is the single most actionable thing that can happen to a car you
   * are already interested in. Price history only records actual changes, so
   * "more than one observation" already means "the price moved".
   */
  priceDrops(options: { watchedOnly?: boolean; minScore?: number; minDropNok?: number; bigDropPct?: number } = {}): PriceDrop[] {
    const minDrop = options.minDropNok ?? 1000
    // A cut this steep is news whatever the car scored. Live data made the
    // case: a Mazda CX-5 came down 34 900 kr — 41% — on a car scoring 5.7, and
    // a pure score gate would have said nothing at all. A drop that large
    // means something changed, and that is worth knowing either way.
    const bigDrop = options.bigDropPct ?? 0.15
    const rows = this.db
      .query<PriceDrop, []>(
        `SELECT l.ad_id, l.heading, l.url, l.price AS price, l.location, l.year, l.mileage,
                prev.price AS previous_price, latest.observed_at AS changed_at,
                v.score, v.fair_value,
                CASE WHEN w.ad_id IS NULL THEN 0 ELSE 1 END AS watched
         FROM listings l
         JOIN (SELECT ad_id, price, observed_at,
                      ROW_NUMBER() OVER (PARTITION BY ad_id ORDER BY observed_at DESC, id DESC) rn
               FROM price_history) latest ON latest.ad_id = l.ad_id AND latest.rn = 1
         JOIN (SELECT ad_id, price,
                      ROW_NUMBER() OVER (PARTITION BY ad_id ORDER BY observed_at DESC, id DESC) rn
               FROM price_history) prev ON prev.ad_id = l.ad_id AND prev.rn = 2
         LEFT JOIN valuations v ON v.ad_id = l.ad_id
         LEFT JOIN watchlist w ON w.ad_id = l.ad_id
         WHERE l.delisted_at IS NULL AND l.price < prev.price
         ORDER BY latest.observed_at DESC`,
      )
      .all()

    return rows.filter((row) => {
      const cut = row.previous_price - row.price
      if (cut < minDrop) return false
      if (options.watchedOnly && !row.watched) return false

      // Three ways through the score gate: you are following the car, or the
      // car was already interesting, or the cut is steep enough to be the
      // story by itself.
      const steep = row.previous_price > 0 && cut / row.previous_price >= bigDrop
      if (options.minScore != null && !row.watched && !steep && (row.score ?? 0) < options.minScore) return false
      return true
    })
  }

  isWatched(adId: number): boolean {
    return this.db.query("SELECT 1 FROM watchlist WHERE ad_id = ?").get(adId) !== null
  }

  watchedAdIds(): Set<number> {
    return new Set((this.db.query<{ ad_id: number }, []>("SELECT ad_id FROM watchlist").all()).map((r) => r.ad_id))
  }

  markNotified(adId: number, reason: string): boolean {
    const changes = this.db.query("INSERT OR IGNORE INTO notified (ad_id, reason, sent_at) VALUES (?, ?, ?)").run(adId, reason, Date.now())
    return changes.changes > 0
  }

  // -------------------------------------------------------------------------
  // LLM call log — the evidence behind "is the cheap provider good enough?"
  // -------------------------------------------------------------------------

  logLlmCall(record: CallRecord): void {
    this.db
      .query(
        `INSERT INTO llm_calls (ts, task, ad_id, provider, model, ok, escalate_reason, latency_ms, attempt, image_count, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        record.task,
        record.ref ? Number(record.ref) || null : null,
        record.provider,
        record.model,
        record.ok ? 1 : 0,
        record.escalateReason ?? null,
        record.latencyMs,
        record.attempt,
        record.imageCount,
        record.detail ?? null,
      )
  }

  llmStats(sinceMs?: number): Array<{ task: string; provider: string; calls: number; ok: number; p50_ms: number; escalations: number }> {
    const since = sinceMs ?? 0
    return this.db
      .query<{ task: string; provider: string; calls: number; ok: number; p50_ms: number; escalations: number }, [number]>(
        `SELECT task, provider,
                COUNT(*) AS calls,
                SUM(ok) AS ok,
                CAST(AVG(latency_ms) AS INTEGER) AS p50_ms,
                SUM(CASE WHEN escalate_reason IS NOT NULL THEN 1 ELSE 0 END) AS escalations
         FROM llm_calls WHERE ts >= ?
         GROUP BY task, provider ORDER BY task, provider`,
      )
      .all(since)
  }
}
