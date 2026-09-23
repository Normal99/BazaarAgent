import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { databasePath } from "./paths.ts"
import type { SearchEntry } from "./finn/types.ts"
import type { ItemSpecs } from "./finn/item.ts"
import type { CallRecord } from "llm-brain"

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

CREATE TABLE IF NOT EXISTS price_history (
  ad_id       INTEGER NOT NULL REFERENCES listings(ad_id),
  observed_at INTEGER NOT NULL,
  price       INTEGER NOT NULL,
  PRIMARY KEY (ad_id, observed_at)
);

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
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Searches
  // -------------------------------------------------------------------------

  addSearch(name: string, url: string, budget?: number, minScore = 6): number {
    const row = this.db
      .query<{ id: number }, [string, string, number | null, number, number]>(
        `INSERT INTO searches (name, url, budget_nok, min_score, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET name = excluded.name, budget_nok = excluded.budget_nok, min_score = excluded.min_score
         RETURNING id`,
      )
      .get(name, url, budget ?? null, minScore, Date.now())
    return row!.id
  }

  listSearches(activeOnly = true): Array<{ id: number; name: string; url: string; budget_nok: number | null; min_score: number; last_swept: number | null }> {
    return this.db
      .query<{ id: number; name: string; url: string; budget_nok: number | null; min_score: number; last_swept: number | null }, []>(
        `SELECT id, name, url, budget_nok, min_score, last_swept FROM searches ${activeOnly ? "WHERE active = 1" : ""} ORDER BY id`,
      )
      .all()
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
  ingest(entries: readonly SearchEntry[]): Change[] {
    const now = Date.now()
    const changes: Change[] = []

    const existing = this.db.query<{ ad_id: number; price: number; vin: string | null }, [number]>(
      "SELECT ad_id, price, vin FROM listings WHERE ad_id = ?",
    )
    const byVin = this.db.query<{ ad_id: number; price: number; first_seen: number }, [string, number]>(
      `SELECT ad_id, price, first_seen FROM listings
       WHERE vin = ? AND ad_id != ? ORDER BY last_seen DESC LIMIT 1`,
    )

    const upsert = this.db.query(
      `INSERT INTO listings (
         ad_id, vin, regno, heading, url, make, model, series, spec, year, mileage, price,
         fuel, transmission, dealer_segment, org_id, org_name, location, lat, lon,
         registration_class, published_at, first_seen, last_seen, image_urls, raw_json
       ) VALUES (
         $ad_id, $vin, $regno, $heading, $url, $make, $model, $series, $spec, $year, $mileage, $price,
         $fuel, $transmission, $dealer_segment, $org_id, $org_name, $location, $lat, $lon,
         $registration_class, $published_at, $now, $now, $image_urls, $raw_json
       )
       ON CONFLICT(ad_id) DO UPDATE SET
         price = excluded.price, mileage = excluded.mileage, last_seen = excluded.last_seen,
         heading = excluded.heading, raw_json = excluded.raw_json, delisted_at = NULL`,
    )
    const addPrice = this.db.query("INSERT OR IGNORE INTO price_history (ad_id, observed_at, price) VALUES (?, ?, ?)")

    const transaction = this.db.transaction((rows: readonly SearchEntry[]) => {
      for (const entry of rows) {
        const previous = existing.get(entry.ad_id)
        const price = entry.price.amount

        if (!previous) {
          // A VIN we have seen under a different ad id means the seller relisted
          // rather than sold — invisible on finn, and the strongest leverage there is.
          const prior = entry.chassis_number ? byVin.get(entry.chassis_number, entry.ad_id) : undefined
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
        })
        addPrice.run(entry.ad_id, now, price)
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
        "SELECT observed_at, price FROM price_history WHERE ad_id = ? ORDER BY observed_at",
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
    const where: string[] = ["make = ?", "year BETWEEN ? AND ?", "mileage IS NOT NULL", "year IS NOT NULL", "price > 0", "delisted_at IS NULL"]
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
