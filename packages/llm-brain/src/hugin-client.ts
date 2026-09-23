import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { statePath, setupHint } from "./state.ts"

// The single Hugin (hugin.telemarkfylke.no) chat client for AgentMark.
//
// Hugin's /api/chat is SSE-only, is NOT stateless despite `store: false`
// (every request must borrow an authorized chatconfig `_id`), puts the event
// name on the SSE `event:` line rather than in the JSON payload, and returns
// HTTP 500 if the hosted `web_search` tool is omitted. All of that is handled
// here so nothing else in AgentMark re-implements it (the Rust side previously
// had its own copy — see src-tauri/src/lib.rs history).

const BASE_URL = "https://hugin.telemarkfylke.no"
const CHAT_PATH = "/api/chat"
const MODEL = "gpt-5.6-terra"

const CONFIG_PATH = () => statePath("hugin.json")

export class HuginError extends Error {
  constructor(
    readonly kind: "authentication" | "provider" | "network",
    message: string,
  ) {
    super(message)
    this.name = "HuginError"
  }
}

export type HuginInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; imageUrl: string }

// Hugin wraps each turn in a `message.input` / `message.output` envelope around
// otherwise-familiar `input_text` / `output_text` content. `input_image` uses
// camelCase `imageUrl` (snake_case `image_url` is silently ignored → 500).
export type HuginInput =
  | { type: "message.input"; role: "user" | "developer" | "system"; content: HuginInputContent[] }
  | { type: "message.output"; role: "assistant"; content: { type: "output_text"; text: string }[] }

export interface Citation {
  readonly url: string
  readonly title: string
}

export interface HuginResult {
  readonly text: string
  readonly citations: Citation[]
  readonly usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
}

export interface StreamOptions {
  readonly instructions: string
  readonly inputs: HuginInput[]
  readonly signal?: AbortSignal
  /** Called with each text delta as it arrives, for live display. */
  readonly onDelta?: (delta: string) => void
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function resolveCookie(): string | undefined {
  const fromEnv = process.env.HUGIN_COOKIE?.trim()
  if (fromEnv) return fromEnv
  try {
    if (!existsSync(CONFIG_PATH())) return undefined
    const cookie = (JSON.parse(readFileSync(CONFIG_PATH(), "utf8")) as { cookie?: unknown }).cookie
    return typeof cookie === "string" && cookie.length > 0 ? cookie : undefined
  } catch {
    return undefined
  }
}

function normalizeCookie(value: string): string {
  const cookie = value.trim().replace(/^['"]|['"]$/g, "")
  if (!cookie) throw new HuginError("authentication", "A Hugin session cookie is required.")
  return cookie.startsWith("AppServiceAuthSession=") ? cookie : `AppServiceAuthSession=${cookie}`
}

/** Validate a pasted cookie against Hugin and, on success, save it to ~/.agentmark/hugin.json (owner-only). */
export async function configure(rawCookie: string): Promise<void> {
  const cookie = normalizeCookie(rawCookie)
  const response = await fetch(`${BASE_URL}/api/chatconfigs`, { headers: { cookie } }).catch((error) => {
    throw new HuginError("network", `Could not reach Hugin: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (response.status === 401)
    throw new HuginError("authentication", "Hugin rejected that session cookie. Sign in at hugin.telemarkfylke.no and paste a current AppServiceAuthSession value.")
  if (!response.ok) throw new HuginError("provider", `Hugin validation returned ${response.status} ${response.statusText}.`)
  writeFileSync(CONFIG_PATH(), `${JSON.stringify({ cookie }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(CONFIG_PATH(), 0o600)
}

export async function status(): Promise<{ connected: boolean; detail: string }> {
  const cookie = resolveCookie()
  if (!cookie) return { connected: false, detail: `Hugin is not configured.${setupHint("hugin")}` }
  const response = await fetch(`${BASE_URL}/api/chatconfigs`, { headers: { cookie } }).catch(() => undefined)
  if (!response) return { connected: false, detail: "Could not reach Hugin." }
  if (response.status === 401) return { connected: false, detail: `Hugin session expired.${setupHint("hugin")}` }
  return response.ok
    ? { connected: true, detail: "Hugin is connected." }
    : { connected: false, detail: `Hugin returned ${response.status} ${response.statusText}.` }
}

// ---------------------------------------------------------------------------
// Chatconfig borrow (cached per cookie for the process; only successes cached)
// ---------------------------------------------------------------------------

interface ChatConfigEnvelope {
  _id: unknown
  name: unknown
  description: unknown
  vendorId: unknown
  accessGroups: unknown
  type: unknown
  created: unknown
  updated: unknown
}

const envelopeCache = new Map<string, ChatConfigEnvelope>()

async function chatConfigEnvelope(cookie: string): Promise<ChatConfigEnvelope> {
  const cached = envelopeCache.get(cookie)
  if (cached) return cached
  const response = await fetch(`${BASE_URL}/api/chatconfigs`, { headers: { cookie } }).catch((error) => {
    throw new HuginError("network", `Could not load Hugin chat configurations: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (response.status === 401) throw new HuginError("authentication", `Hugin session expired.${setupHint("hugin")}`)
  if (!response.ok) throw new HuginError("provider", `Hugin chat configuration lookup returned ${response.status} ${response.statusText}.`)
  const configs = (await response.json().catch(() => undefined)) as unknown
  if (!Array.isArray(configs)) throw new HuginError("provider", "Hugin returned an invalid chat configuration list.")
  const match =
    configs.find((c): c is Record<string, unknown> => !!c && typeof c === "object" && (c as Record<string, unknown>).vendorId === "OPENAI") ??
    (configs[0] as Record<string, unknown> | undefined)
  if (!match)
    throw new HuginError("provider", "No usable Hugin chat configuration is available for this account. Ask an admin to publish one, or create a private one at hugin.telemarkfylke.no.")
  const envelope: ChatConfigEnvelope = {
    _id: match._id,
    name: match.name,
    description: match.description,
    vendorId: match.vendorId ?? "OPENAI",
    accessGroups: Array.isArray(match.accessGroups) ? match.accessGroups : [],
    type: typeof match.type === "string" ? match.type : "published",
    created: match.created,
    updated: match.updated,
  }
  envelopeCache.set(cookie, envelope)
  return envelope
}

// ---------------------------------------------------------------------------
// Streaming request
// ---------------------------------------------------------------------------

/** One Hugin chat turn: sends `inputs`, streams the assistant text, returns the full buffered result. */
export async function streamChat(options: StreamOptions): Promise<HuginResult> {
  const cookie = resolveCookie()
  if (!cookie) throw new HuginError("authentication", `Hugin is not authenticated.${setupHint("hugin")}`)
  const envelope = await chatConfigEnvelope(cookie)

  const body = {
    config: {
      _id: envelope._id,
      name: envelope.name,
      description: envelope.description,
      vendorId: typeof envelope.vendorId === "string" ? envelope.vendorId : "OPENAI",
      project: "DEFAULT",
      model: MODEL,
      instructions: options.instructions.length > 0 ? options.instructions : undefined,
      conversationId: "",
      // Omitting `tools` entirely causes a server-side 500. AgentMark does not
      // drive web_search itself, but Hugin may run it server-side and return
      // citations via `response.annotations`.
      tools: [{ type: "web_search" as const }],
      dataSources: null,
      shared: false,
      type: envelope.type,
      accessGroups: envelope.accessGroups,
      created: envelope.created,
      updated: envelope.updated,
    },
    inputs: options.inputs,
    stream: true as const,
    store: false as const,
  }

  const response = await fetch(`${BASE_URL}${CHAT_PATH}`, {
    method: "POST",
    signal: options.signal,
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  }).catch((error) => {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new HuginError("network", `Could not reach Hugin: ${error instanceof Error ? error.message : String(error)}`)
  })

  if (response.status === 401) throw new HuginError("authentication", `Hugin session expired.${setupHint("hugin")}`)
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 500)
    throw new HuginError("provider", `Hugin returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : "."}`)
  }

  let text = ""
  const citations: Citation[] = []
  let usage: HuginResult["usage"]
  let streamError: string | undefined

  for await (const event of parseSse(response.body)) {
    let data: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(event.data)
      if (!parsed || typeof parsed !== "object") continue
      data = parsed as Record<string, unknown>
    } catch {
      continue
    }

    if (event.event === "response.output_text.delta") {
      const delta = typeof data.content === "string" ? data.content : ""
      if (delta) {
        text += delta
        options.onDelta?.(delta)
      }
      continue
    }
    if (event.event === "response.annotations") {
      for (const annotation of Array.isArray(data.annotations) ? data.annotations : []) {
        if (!annotation || typeof annotation !== "object") continue
        const a = annotation as Record<string, unknown>
        if (a.type === "url_citation" && typeof a.url === "string")
          citations.push({ url: a.url, title: typeof a.title === "string" && a.title.length > 0 ? a.title : a.url })
      }
      continue
    }
    if (event.event === "response.error") {
      streamError =
        (typeof data.message === "string" && data.message) || (typeof data.code === "string" && data.code) || "Hugin stream error"
      continue
    }
    if (event.event === "response.done") {
      usage = data.usage as HuginResult["usage"]
      break
    }
  }

  if (text.trim().length === 0 && streamError) throw new HuginError("provider", `Hugin response error: ${streamError}`)

  const seen = new Set<string>()
  return { text, usage, citations: citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))) }
}

type SseEvent = { event: string; data: string }

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = "message"
        const dataLines: string[] = []
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
        }
        const data = dataLines.join("\n")
        if (data.length > 0 && data !== "[DONE]") yield { event, data }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Convenience one-shot wrappers (used by brief.ts)
// ---------------------------------------------------------------------------

export async function complete(instructions: string, prompt: string): Promise<string> {
  const result = await streamChat({
    instructions,
    inputs: [{ type: "message.input", role: "user", content: [{ type: "input_text", text: prompt }] }],
  })
  return result.text.trim()
}

export async function completeWithImage(instructions: string, prompt: string, png: Uint8Array): Promise<string> {
  return completeWithImages(instructions, prompt, [`data:image/png;base64,${Buffer.from(png).toString("base64")}`])
}

/**
 * Vision, with as many images as the caller wants.
 *
 * Hugin will not take a remote URL — the bytes have to travel inline — so any
 * `http(s)` URL here is fetched and base64-encoded first. `data:` URLs pass
 * through untouched. The mime type comes from the response rather than being
 * assumed: finn serves JPEG, and the original single-image helper hardcoded
 * `image/png`, which would have mislabelled every car photo.
 */
export async function completeWithImages(instructions: string, prompt: string, urls: string[], signal?: AbortSignal): Promise<string> {
  const inline = await Promise.all(urls.map((url) => toDataUrl(url, signal)))
  const result = await streamChat({
    instructions,
    signal,
    inputs: [
      {
        type: "message.input",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          // camelCase `imageUrl` is required; snake_case is silently ignored → 500.
          ...inline.map((imageUrl) => ({ type: "input_image" as const, imageUrl })),
        ],
      },
    ],
  })
  return result.text.trim()
}

async function toDataUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (url.startsWith("data:")) return url
  const response = await fetch(url, { signal }).catch((error) => {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new HuginError("network", `Could not fetch image ${url}: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!response.ok) throw new HuginError("network", `Could not fetch image ${url}: HTTP ${response.status}.`)
  const mime = (response.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim()
  const bytes = Buffer.from(await response.arrayBuffer())
  return `data:${mime};base64,${bytes.toString("base64")}`
}
