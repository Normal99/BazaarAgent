import type { ZodType } from "zod"
import { ProviderError, type ImageRef, type LLMProvider } from "./provider.ts"

// Quality-gated fallback.
//
// `resolveProvider()` style selection picks one provider and lives with it. That
// is fine when the provider is reliable and fatal when it is not: a gateway
// without native structured output will occasionally answer with prose, a
// half-closed brace, or JSON whose shape is subtly wrong, and none of those
// raise an HTTP error. So the gate here is the *parsed value*, not the status
// code — a reply only counts as success once it survives `schema.parse`.
//
// Order is primary → repair on the same provider → fallback. Every attempt is
// reported through `onCall` so the host can answer "was the cheap provider
// actually good enough?" from its own logs instead of from an impression.

export type EscalateReason =
  | "provider_error"
  | "network"
  | "timeout"
  | "empty"
  | "no_json"
  | "schema_invalid"
  | "vision_unsupported"

export interface CallRecord {
  readonly task: string
  /** Caller's identifier for the subject, e.g. a finn ad_id. */
  readonly ref?: string
  readonly provider: string
  readonly model: string
  readonly ok: boolean
  readonly escalateReason?: EscalateReason
  readonly latencyMs: number
  /** 1 for the first try on a provider, 2+ for repair retries. */
  readonly attempt: number
  readonly imageCount: number
  readonly detail?: string
}

export interface StructuredOptions {
  readonly primary: LLMProvider
  /** Omitted means no escalation — the primary's failure is the caller's failure. */
  readonly fallback?: LLMProvider
  readonly onCall?: (record: CallRecord) => void
  /** Per-attempt ceiling. Default 90s; vision calls are slow. */
  readonly timeoutMs?: number
  /** Repair retries on the same provider before escalating. Default 1. */
  readonly repairAttempts?: number
}

export interface StructuredRequest<T> {
  readonly task: string
  readonly ref?: string
  readonly system: string
  readonly prompt: string
  readonly schema: ZodType<T>
  readonly images?: readonly ImageRef[]
  readonly signal?: AbortSignal
}

export interface StructuredResult<T> {
  readonly value: T
  readonly provider: string
  readonly model: string
  readonly escalated: boolean
  readonly reason?: EscalateReason
}

export class StructuredError extends Error {
  constructor(
    readonly reason: EscalateReason,
    message: string,
    readonly lastReply?: string,
  ) {
    super(message)
    this.name = "StructuredError"
  }
}

/**
 * Pull a JSON object out of a model reply.
 *
 * Models fence JSON, prefix it with "Here is the analysis:", or append a
 * sign-off. Scanning for the first balanced object is more forgiving than
 * `JSON.parse` on the whole string and more accurate than a greedy
 * `/\{.*\}/s`, which swallows trailing prose that happens to contain a brace.
 * String contents are skipped so a `}` inside a Norwegian description cannot
 * close the object early.
 */
export function extractJson(reply: string): unknown {
  const text = reply.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")
  const start = text.indexOf("{")
  if (start === -1) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

function classify(error: unknown): { reason: EscalateReason; detail: string } {
  if (error instanceof ProviderError) {
    const reason: EscalateReason = error.kind === "network" ? "network" : "provider_error"
    return { reason, detail: error.message }
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return { reason: "timeout", detail: error.message }
    return { reason: "provider_error", detail: error.message }
  }
  return { reason: "provider_error", detail: String(error) }
}

const REPAIR = (raw: string, problem: string) =>
  [
    "Your previous reply could not be used.",
    `Problem: ${problem}`,
    "",
    "Reply again with ONLY the JSON object — no prose before or after it, no markdown fences.",
    "It must match the requested schema exactly.",
    "",
    "Your previous reply was:",
    raw.slice(0, 2000),
  ].join("\n")

/**
 * Ask for a schema-validated object, escalating to the fallback provider when
 * the primary cannot produce one.
 */
export function structured(options: StructuredOptions) {
  const timeoutMs = options.timeoutMs ?? 90_000
  const repairAttempts = options.repairAttempts ?? 1

  return async function run<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const images = request.images ?? []
    const chain: LLMProvider[] = [options.primary, ...(options.fallback ? [options.fallback] : [])]
    let lastReason: EscalateReason = "provider_error"
    let lastDetail = "no attempt was made"
    let lastReply: string | undefined

    for (const [index, provider] of chain.entries()) {
      if (images.length > 0 && !provider.vision) {
        options.onCall?.({
          task: request.task,
          ref: request.ref,
          provider: provider.id,
          model: provider.model,
          ok: false,
          escalateReason: "vision_unsupported",
          latencyMs: 0,
          attempt: 1,
          imageCount: images.length,
        })
        lastReason = "vision_unsupported"
        lastDetail = `${provider.id} cannot accept images`
        continue
      }

      let prompt = request.prompt
      for (let attempt = 1; attempt <= 1 + repairAttempts; attempt++) {
        const started = Date.now()
        const signal = request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)

        let reply: string
        try {
          reply =
            images.length > 0
              ? await provider.completeVision(request.system, prompt, [...images], signal)
              : await provider.complete(request.system, prompt, signal)
        } catch (error) {
          // A caller-initiated abort is not a provider failure — do not escalate.
          if (request.signal?.aborted) throw error
          const { reason, detail } = classify(error)
          options.onCall?.({
            task: request.task,
            ref: request.ref,
            provider: provider.id,
            model: provider.model,
            ok: false,
            escalateReason: reason,
            latencyMs: Date.now() - started,
            attempt,
            imageCount: images.length,
            detail,
          })
          lastReason = reason
          lastDetail = detail
          break // a transport failure will not be fixed by rephrasing; move on
        }

        const latencyMs = Date.now() - started
        lastReply = reply

        let reason: EscalateReason | undefined
        let detail = ""
        if (reply.trim().length === 0) {
          reason = "empty"
          detail = "the provider returned an empty reply"
        } else {
          const raw = extractJson(reply)
          if (raw === undefined) {
            reason = "no_json"
            detail = "no JSON object could be found in the reply"
          } else {
            const parsed = request.schema.safeParse(raw)
            if (parsed.success) {
              options.onCall?.({
                task: request.task,
                ref: request.ref,
                provider: provider.id,
                model: provider.model,
                ok: true,
                latencyMs,
                attempt,
                imageCount: images.length,
              })
              return {
                value: parsed.data,
                provider: provider.id,
                model: provider.model,
                escalated: index > 0,
                reason: index > 0 ? lastReason : undefined,
              }
            }
            reason = "schema_invalid"
            detail = parsed.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
              .join("; ")
          }
        }

        options.onCall?.({
          task: request.task,
          ref: request.ref,
          provider: provider.id,
          model: provider.model,
          ok: false,
          escalateReason: reason,
          latencyMs,
          attempt,
          imageCount: images.length,
          detail,
        })
        lastReason = reason
        lastDetail = detail
        prompt = REPAIR(reply, detail)
      }
    }

    throw new StructuredError(lastReason, `Could not get a valid ${request.task} response: ${lastDetail}`, lastReply)
  }
}
