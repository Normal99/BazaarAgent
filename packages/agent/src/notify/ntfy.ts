import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "../paths.ts"
import type { ScoredListing } from "../pipeline.ts"

// ntfy rather than web push: it reaches an Android phone and a desktop with no
// HTTPS certificate, no VAPID keys and no service worker, and it works over
// Tailscale against a self-hosted server. The whole notification layer is one
// HTTP POST.

export interface NtfyConfig {
  server: string
  topic: string
  /** Bearer token, for a protected topic. */
  token?: string
}

const CONFIG_PATH = () => join(stateDir, "ntfy.json")

export function loadNtfyConfig(): NtfyConfig | undefined {
  const envTopic = process.env.BAZAAR_NTFY_TOPIC?.trim()
  if (envTopic) return { server: process.env.BAZAAR_NTFY_SERVER?.trim() || "https://ntfy.sh", topic: envTopic, token: process.env.BAZAAR_NTFY_TOKEN?.trim() }
  try {
    if (!existsSync(CONFIG_PATH())) return undefined
    const raw = JSON.parse(readFileSync(CONFIG_PATH(), "utf8")) as Partial<NtfyConfig>
    if (!raw.topic) return undefined
    return { server: raw.server || "https://ntfy.sh", topic: raw.topic, token: raw.token }
  } catch {
    return undefined
  }
}

export function saveNtfyConfig(config: NtfyConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(CONFIG_PATH(), 0o600)
}

export interface Notification {
  readonly title: string
  readonly body: string
  readonly priority?: 1 | 2 | 3 | 4 | 5
  readonly tags?: string[]
  /** Tapping the notification opens this. */
  readonly click?: string
}

/**
 * Make a header value safe to send.
 *
 * HTTP headers are ASCII, and Norwegian titles are not — model names, place
 * names and the "·" separator all break it. percent-encoding looked plausible
 * and was wrong: ntfy has no X-Title-Encoding header, so a phone displayed the
 * literal "119%C2%A0900%20kr%20%C2%B7%20Audi". RFC 2047 encoded-words are what
 * ntfy actually decodes. Pure-ASCII titles are sent untouched so the common
 * case stays readable in logs.
 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

export async function send(notification: Notification, config = loadNtfyConfig()): Promise<boolean> {
  if (!config) return false
  const headers: Record<string, string> = {
    Title: encodeHeader(notification.title),
    Priority: String(notification.priority ?? 3),
  }
  if (notification.tags?.length) headers.Tags = notification.tags.join(",")
  if (notification.click) headers.Click = notification.click
  if (config.token) headers.Authorization = `Bearer ${config.token}`

  const response = await fetch(`${config.server.replace(/\/$/, "")}/${config.topic}`, {
    method: "POST",
    headers,
    body: notification.body,
  }).catch(() => undefined)

  return response?.ok ?? false
}

const kr = (n: number) => `${Math.round(n).toLocaleString("nb-NO")} kr`

/**
 * A price cut on a car you are following.
 *
 * Deliberately louder than a new find. A new listing is one of many; a seller
 * moving on price is a specific, time-limited opening on a car you already
 * decided you wanted.
 */
export function dropNotification(drop: {
  heading: string
  url: string
  price: number
  previous_price: number
  year: number | null
  mileage: number | null
  location: string | null
  fair_value: number | null
  watched: number
}): Notification {
  const cut = drop.previous_price - drop.price
  const share = drop.previous_price > 0 ? cut / drop.previous_price : 0

  const lines = [
    `${kr(drop.previous_price)} → ${kr(drop.price)}  (−${(share * 100).toFixed(0)} %)`,
    [drop.year, drop.mileage != null ? `${drop.mileage.toLocaleString("nb-NO")} km` : null, drop.location]
      .filter(Boolean)
      .join(" · "),
  ]
  if (drop.fair_value) {
    const residual = (drop.fair_value - drop.price) / drop.fair_value
    if (residual > 0) lines.push(`Nå ${(residual * 100).toFixed(0)} % under marked (est. ${kr(drop.fair_value)})`)
  }

  return {
    title: `↓ ${kr(cut)} · ${drop.heading}`,
    body: lines.join("\n"),
    // A cut on a followed car outranks a new find: you already want this one.
    priority: drop.watched ? 4 : 3,
    tags: drop.watched ? ["chart_with_downwards_trend", "star"] : ["chart_with_downwards_trend"],
    click: drop.url,
  }
}

/** Turn a scored listing into something worth reading on a lock screen. */
export function dealNotification(deal: ScoredListing, budget?: number): Notification {
  const { listing, valuation, plan, score } = deal
  const under = valuation.residualPct > 0 ? `${(valuation.residualPct * 100).toFixed(0)}% under marked` : `${(-valuation.residualPct * 100).toFixed(0)}% over marked`

  const lines = [`${under} (est. ${kr(valuation.fairValue)})`, `${listing.year} · ${listing.mileage.toLocaleString("nb-NO")} km · ${listing.dealer_segment ?? "?"} · ${listing.location ?? ""}`]

  // The headline case: over budget on the sticker, reachable by negotiating.
  if (plan?.haggleableIntoBudget) lines.push(`${kr(plan.overBudgetBy!)} over budsjett — forhandlebart ned til ${kr(plan.target)}`)
  else if (plan) lines.push(`Mål: ${kr(plan.target)} · gå fra ved ${kr(plan.walkAway)}`)

  if (deal.registryFindings.length > 0) lines.push(`⚠ ${deal.registryFindings[0]}`)
  if (deal.analysis?.redFlags.length) lines.push(`${deal.analysis.redFlags.length} røde flagg`)

  const tags = ["car"]
  if (score >= 8) tags.unshift("fire")
  if (plan?.haggleableIntoBudget) tags.push("handshake")
  if (deal.registryFindings.length > 0) tags.push("warning")

  return {
    title: `${kr(listing.price)} · ${listing.heading}`,
    body: lines.join("\n"),
    priority: score >= 8 ? 4 : 3,
    tags,
    click: listing.url,
  }
}
