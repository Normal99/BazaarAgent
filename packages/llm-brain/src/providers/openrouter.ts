import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { statePath, setupHint } from "../state.ts"
import { ProviderError, type AgentMessage, type Citation, type LLMProvider, type StepInput, type StepResult, type ToolCall, type ImageRef } from "../provider.ts"

// OpenRouter provider — OpenAI-compatible /chat/completions with native tool
// calling and SSE streaming. Any OpenRouter model id works; the desktop app
// pulls the live catalogue from listModels().

const BASE_URL = "https://openrouter.ai/api/v1"
const KEY_PATH = () => statePath("openrouter.json")
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash"

// OpenRouter shows these on the account's activity page. The host app sets them
// so usage is attributable to whichever app made the call.
let appName = "llm-brain"
let appUrl = "https://github.com/Normal99/BazaarAgent"

export function setOpenRouterApp(name: string, url: string): void {
  appName = name
  appUrl = url
}

const HEADERS = () => ({
  "content-type": "application/json",
  "HTTP-Referer": appUrl,
  "X-Title": appName,
})

export function openRouterKey(): string | undefined {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    if (!existsSync(KEY_PATH())) return undefined
    const key = (JSON.parse(readFileSync(KEY_PATH(), "utf8")) as { key?: unknown }).key
    return typeof key === "string" && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

export async function configureOpenRouter(rawKey: string): Promise<void> {
  const key = rawKey.trim()
  if (!key.startsWith("sk-or-")) throw new ProviderError("authentication", "An OpenRouter API key looks like `sk-or-...`.")
  const response = await fetch(`${BASE_URL}/key`, { headers: { ...HEADERS(), authorization: `Bearer ${key}` } }).catch((error) => {
    throw new ProviderError("network", `Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (response.status === 401) throw new ProviderError("authentication", "OpenRouter rejected that API key.")
  if (!response.ok) throw new ProviderError("provider", `OpenRouter key check returned ${response.status}.`)
  writeFileSync(KEY_PATH(), `${JSON.stringify({ key }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(KEY_PATH(), 0o600)
}

export async function openRouterStatus(): Promise<{ connected: boolean; detail: string }> {
  const key = openRouterKey()
  if (!key) return { connected: false, detail: `OpenRouter is not configured.${setupHint("openrouter")}` }
  const response = await fetch(`${BASE_URL}/key`, { headers: { ...HEADERS(), authorization: `Bearer ${key}` } }).catch(() => undefined)
  if (!response) return { connected: false, detail: "Could not reach OpenRouter." }
  if (response.status === 401) return { connected: false, detail: `OpenRouter API key was rejected.${setupHint("openrouter")}` }
  if (!response.ok) return { connected: false, detail: `OpenRouter returned ${response.status}.` }
  const info = (await response.json().catch(() => ({}))) as { data?: { usage?: number; limit?: number | null } }
  const usage = info.data?.usage
  return {
    connected: true,
    detail: typeof usage === "number" ? `OpenRouter connected — $${usage.toFixed(2)} used${info.data?.limit ? ` of $${info.data.limit}` : ""}.` : "OpenRouter connected.",
  }
}

export interface CatalogueModel {
  id: string
  name: string
  contextLength?: number
  promptPrice?: number
  completionPrice?: number
}

/** Live model catalogue, filtered to models that support tool calling. */
export async function listModels(): Promise<CatalogueModel[]> {
  const response = await fetch(`${BASE_URL}/models`, { headers: HEADERS() }).catch((error) => {
    throw new ProviderError("network", `Could not load the OpenRouter model list: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!response.ok) throw new ProviderError("provider", `OpenRouter model list returned ${response.status}.`)
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> }
  return (body.data ?? [])
    .filter((m) => Array.isArray(m.supported_parameters) && (m.supported_parameters as string[]).includes("tools"))
    .filter((m) => !String(m.id).startsWith("openrouter/") && !String(m.id).endsWith(":batch"))
    .map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      promptPrice: Number((m.pricing as Record<string, unknown> | undefined)?.prompt) || undefined,
      completionPrice: Number((m.pricing as Record<string, unknown> | undefined)?.completion) || undefined,
    }))
    .sort((a, b) => (a.promptPrice ?? 1) - (b.promptPrice ?? 1))
}

// ---------------------------------------------------------------------------

/**
 * OpenAI-style content. A plain string is still valid and is what every
 * text-only call sends; the array form exists for vision, where each image
 * rides along as an `image_url` part. OpenRouter accepts a remote URL directly,
 * so nothing has to be downloaded on this path.
 */
type OpenAiContent = string | null | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }>

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: OpenAiContent
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function lower(system: string, messages: AgentMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }]
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.content })
    else if (message.role === "assistant")
      out.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      })
    else out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content })
  }
  return out
}

export function makeOpenRouterProvider(model: string): LLMProvider {
  const request = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> => {
    const key = openRouterKey()
    if (!key) throw new ProviderError("authentication", `OpenRouter is not authenticated.${setupHint("openrouter")}`)
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal,
      headers: { ...HEADERS(), authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") throw error
      throw new ProviderError("network", `Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (response.status === 401) throw new ProviderError("authentication", "OpenRouter API key was rejected.")
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 400)
      throw new ProviderError("provider", `OpenRouter returned ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`)
    }
    return response
  }

  return {
    id: "openrouter",
    model,
    vision: true,

    async step(input: StepInput): Promise<StepResult> {
      const response = await request(
        {
          model,
          messages: lower(input.system, input.messages),
          tools: input.tools.length
            ? input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
            : undefined,
          stream: true,
          usage: { include: true },
        },
        input.signal,
      )
      return consumeStream(response.body!, input.onDelta)
    },

    async complete(system: string, prompt: string, signal?: AbortSignal): Promise<string> {
      const response = await request(
        { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], stream: false },
        signal,
      )
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      return (body.choices?.[0]?.message?.content ?? "").trim()
    },

    async completeVision(system: string, prompt: string, images: ImageRef[], signal?: AbortSignal): Promise<string> {
      const content: OpenAiContent = [
        { type: "text", text: prompt },
        ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.url, detail: image.detail ?? "low" } })),
      ]
      const response = await request(
        { model, messages: [{ role: "system", content: system }, { role: "user", content }], stream: false },
        signal,
      )
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      return (body.choices?.[0]?.message?.content ?? "").trim()
    },
  }
}

async function consumeStream(body: ReadableStream<Uint8Array>, onDelta?: (text: string) => void): Promise<StepResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let finishReason: StepResult["finishReason"] = "stop"
  let usage: StepResult["usage"]
  const citations: Citation[] = []
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        let event: {
          choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
        }
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        const choice = event.choices?.[0]
        if (choice?.delta?.content) {
          text += choice.delta.content
          onDelta?.(choice.delta.content)
        }
        for (const part of choice?.delta?.tool_calls ?? []) {
          const entry = toolAcc.get(part.index) ?? { id: "", name: "", args: "" }
          if (part.id) entry.id = part.id
          if (part.function?.name) entry.name = part.function.name
          if (part.function?.arguments) entry.args += part.function.arguments
          toolAcc.set(part.index, entry)
        }
        if (choice?.finish_reason) {
          finishReason =
            choice.finish_reason === "tool_calls"
              ? "tool_calls"
              : choice.finish_reason === "length"
                ? "length"
                : choice.finish_reason === "stop"
                  ? "stop"
                  : "stop"
        }
        if (event.usage)
          usage = {
            inputTokens: event.usage.prompt_tokens,
            outputTokens: event.usage.completion_tokens,
            totalTokens: event.usage.total_tokens,
            cost: event.usage.cost,
          }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => ({
      id: entry.id || crypto.randomUUID(),
      name: entry.name,
      arguments: parseArgs(entry.args),
    }))
    .filter((call) => call.name)

  return { text: text.trim(), toolCalls, citations, usage, finishReason: toolCalls.length ? "tool_calls" : finishReason }
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsed: raw }
  }
}
