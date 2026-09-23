import type { Citation } from "./hugin-client.ts"

// Provider-neutral LLM interface. Callers talk only to this; each concrete
// provider (providers/openrouter.ts, providers/hugin.ts) lowers the neutral
// message/tool shapes to its own wire format and raises the reply back. Native
// tool calling (OpenRouter) and Hugin's text <tool_call> emulation both satisfy
// the same contract.

export { type Citation } from "./hugin-client.ts"

export class ProviderError extends Error {
  constructor(
    readonly kind: "authentication" | "provider" | "network" | "config",
    message: string,
  ) {
    super(message)
    this.name = "ProviderError"
  }
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

export type AgentMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: ToolCall[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly name: string; readonly content: string }

/** One tool as the provider needs to see it — a JSON Schema for the arguments. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: object
}

export interface Usage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  /** USD, when the provider reports it. */
  readonly cost?: number
}

export interface StepInput {
  readonly system: string
  readonly messages: AgentMessage[]
  readonly tools: ToolSpec[]
  readonly signal?: AbortSignal
  readonly onDelta?: (text: string) => void
}

export interface StepResult {
  /** Visible reasoning, when the provider exposes it (Hugin's <lemma>, or a reasoning channel). */
  readonly reasoning?: string
  readonly text: string
  readonly toolCalls: ToolCall[]
  readonly citations: Citation[]
  readonly usage?: Usage
  readonly finishReason: "tool_calls" | "stop" | "length" | "error"
}

/**
 * One image for a vision call, always identified by URL.
 *
 * The two providers want opposite things and the caller should not have to care:
 * OpenRouter takes a remote URL straight through in `image_url`, while Hugin
 * only accepts bytes inline and so fetches and base64-encodes first. A `data:`
 * URL works on both paths, so callers that already hold bytes can pass one.
 */
export interface ImageRef {
  readonly url: string
  /** Hint for providers that support it; "low" keeps token cost down. */
  readonly detail?: "low" | "high"
}

export interface LLMProvider {
  readonly id: string
  readonly model: string
  /** Whether completeVision() will work, rather than throw. */
  readonly vision: boolean
  /** One turn of an agent loop. */
  step(input: StepInput): Promise<StepResult>
  /** A single non-agentic completion. */
  complete(system: string, prompt: string, signal?: AbortSignal): Promise<string>
  /** A single completion that can also see images. Throws ProviderError("config") when `vision` is false. */
  completeVision(system: string, prompt: string, images: ImageRef[], signal?: AbortSignal): Promise<string>
}
