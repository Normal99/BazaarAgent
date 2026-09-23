import { expect, test, describe, beforeEach } from "bun:test"
import { Store } from "../src/store.ts"
import { reap } from "../src/reap.ts"
import { FetchError } from "../src/http.ts"

let store: Store
beforeEach(() => {
  store = new Store(":memory:")
})

/** Stands in for PoliteClient: answers per ad id. */
function fakeClient(byId: Record<number, "live" | 404 | "error">) {
  const seen: number[] = []
  return {
    seen,
    client: {
      async get(url: string) {
        const id = Number(url.split("/").pop())
        seen.push(id)
        const state = byId[id] ?? "live"
        if (state === 404) throw new FetchError(404, url, "not found")
        if (state === "error") throw new FetchError(500, url, "server error")
        return { body: "<html></html>", notModified: false }
      },
    } as any,
  }
}

const insert = (store: Store, adId: number, lastSeenDaysAgo: number) =>
  store.db
    .query(`INSERT INTO listings (ad_id, heading, url, price, first_seen, last_seen, raw_json)
            VALUES (?,?,?,?,?,?,'{}')`)
    .run(adId, `Bil ${adId}`, `https://www.finn.no/mobility/item/${adId}`, 100000, 0, Date.now() - lastSeenDaysAgo * 86_400_000)

const delistedAt = (store: Store, adId: number) =>
  (store.db.query("SELECT delisted_at FROM listings WHERE ad_id = ?").get(adId) as any)?.delisted_at

describe("retiring sold listings", () => {
  test("a 404 means the car is gone", () => {
    insert(store, 1, 3)
    const { client } = fakeClient({ 1: 404 })
    return reap({ store, client, staleAfterHours: 24 }).then((r) => {
      expect(r.delisted).toBe(1)
      expect(delistedAt(store, 1)).toBeGreaterThan(0)
    })
  })

  test("a 200 means it is still for sale, and refreshes last_seen", async () => {
    insert(store, 2, 3)
    const before = (store.db.query("SELECT last_seen FROM listings WHERE ad_id = 2").get() as any).last_seen
    const { client } = fakeClient({ 2: "live" })
    const r = await reap({ store, client, staleAfterHours: 24 })

    expect(r.stillLive).toBe(1)
    expect(delistedAt(store, 2)).toBeNull()
    // Refreshed, so it is not re-checked on every run from now on.
    expect((store.db.query("SELECT last_seen FROM listings WHERE ad_id = 2").get() as any).last_seen).toBeGreaterThan(before)
  })

  test("a server error never retires a live listing", async () => {
    // A timeout or a 500 says nothing about whether the car sold. Retiring on
    // one would silently shrink the comparables corpus during a finn outage.
    insert(store, 3, 3)
    const { client } = fakeClient({ 3: "error" })
    const r = await reap({ store, client, staleAfterHours: 24 })

    expect(r.delisted).toBe(0)
    expect(delistedAt(store, 3)).toBeNull()
  })

  test("recently seen listings are not checked at all", async () => {
    insert(store, 4, 0) // seen just now
    const { client, seen } = fakeClient({})
    const r = await reap({ store, client, staleAfterHours: 24 })

    expect(r.checked).toBe(0)
    expect(seen).toEqual([])
  })

  test("already-retired listings are not re-checked", async () => {
    insert(store, 5, 9)
    store.db.query("UPDATE listings SET delisted_at = ? WHERE ad_id = 5").run(Date.now())
    const { client, seen } = fakeClient({ 5: 404 })
    await reap({ store, client, staleAfterHours: 24 })
    expect(seen).toEqual([])
  })

  test("the cap bounds how many requests one run makes", async () => {
    for (let i = 10; i < 20; i++) insert(store, i, 5)
    const { client, seen } = fakeClient({})
    const r = await reap({ store, client, staleAfterHours: 24, max: 3 })
    expect(r.checked).toBe(3)
    expect(seen).toHaveLength(3)
  })

  test("the stalest are checked first", async () => {
    insert(store, 21, 2)
    insert(store, 22, 30)
    insert(store, 23, 10)
    const { client, seen } = fakeClient({})
    await reap({ store, client, staleAfterHours: 24, max: 2 })
    expect(seen).toEqual([22, 23])
  })
})

describe("delisted listings leave the market", () => {
  test("a retired listing is no longer a comparable", () => {
    insert(store, 30, 3)
    store.db.query("UPDATE listings SET make='Volkswagen', model='Golf VII', year=2018, mileage=100000 WHERE ad_id=30").run()
    expect(store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2015, yearTo: 2020 })).toHaveLength(1)

    store.db.query("UPDATE listings SET delisted_at = ? WHERE ad_id = 30").run(Date.now())
    // This is the whole point: a car that sold must stop counting as evidence
    // of what the market pays, or the corpus drifts toward what did not sell.
    expect(store.comparables({ make: "Volkswagen", model: "Golf VII", yearFrom: 2015, yearTo: 2020 })).toHaveLength(0)
  })
})
