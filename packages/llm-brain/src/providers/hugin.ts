import { streamChat, completeWithImages, type HuginInput, HuginError } from "../hugin-client.ts"
import {
  extractReasoning,
  FINAL_RE,
  jsonRepairHint,
  MISSING_FINAL_HINT,
  dedupeToolCalls,
  parseToolCalls,
  partitionToolCalls,
  stripFinalMarkup,
  stripToolCallMarkup,
  toolCallTag,
  toolManifest,
  toolResultTag,
  TOOL_PROTOCOL,
} from "../tool-protocol.ts"
import { ProviderError, type AgentMessage, type Citation, type ImageRef, type LLMProvider, type StepInput, type StepResult, type ToolCall } from "../provider.ts"

// Hugin provider — the school gateway has no native tool calling, so this wraps
// the text <tool_call> protocol behind the same LLMProvider contract every
// other provider satisfies. The two failsafes that used to live in the agent
// loop (malformed-JSON repair, mid-task missing-<final> nudge) live here now,
// as retries inside a single step(), because they only make sense for this
// wire format.

const MODEL = "gpt-5.6-terra"
const MAX_REPAIR_ATTEMPTS = 2

const asProviderError = (error: unknown): never => {
  if (error instanceof HuginError) throw new ProviderError(error.kind === "authentication" ? "authentication" : "provider", error.message)
  throw error
}

const userInput = (text: string): HuginInput => ({ type: "message.input", role: "user", content: [{ type: "input_text", text }] })
const assistantOutput = (text: string): HuginInput => ({ type: "message.output", role: "assistant", content: [{ type: "output_text", text }] })

function lower(messages: AgentMessage[]): HuginInput[] {
  const out: HuginInput[] = []
  for (const message of messages) {
    if (message.role === "user") out.push(userInput(message.content))
    else if (message.role === "assistant") {
      const text = [message.content, ...(message.toolCalls ?? []).map((c) => toolCallTag(c.name, c.arguments))].filter(Boolean).join("\n")
      if (text) out.push(assistantOutput(text))
    } else {
      // Fold consecutive tool results into one user turn.
      const tag = toolResultTag(message.toolCallId, message.name, message.content)
      const previous = out.at(-1)
      if (previous && previous.type === "message.input" && previous.role === "user" && previous.content[0]?.type === "input_text")
        previous.content[0].text += `\n${tag}`
      else out.push(userInput(tag))
    }
  }
  return out
}

export function makeHuginProvider(): LLMProvider {
  return {
    id: "hugin",
    model: MODEL,
    // The gateway's chat endpoint accepts `input_image` parts. Whether the model
    // behind it reads car photos *well* is a separate question — see the
    // vision-probe command, which measures that rather than assuming it.
    vision: true,

    async step(input: StepInput): Promise<StepResult> {
      const manifest = input.tools.length
        ? `\n\n${TOOL_PROTOCOL}\n\nAvailable tools:\n${toolManifest(input.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })))}`
        : ""
      const instructions = `${input.system}${manifest}`.trim()
      const inputs = lower(input.messages)
      const midTask = input.messages.some((m) => m.role === "tool")

      const run = () => streamChat({ instructions, inputs, signal: input.signal, onDelta: input.onDelta }).catch(asProviderError)

      let result = await run()
      let { reasoning, rest } = extractReasoning(result.text)
      let parsed = partitionToolCalls(parseToolCalls(rest))

      // Malformed-JSON repair.
      for (let attempt = 1; parsed.real.length === 0 && parsed.malformed.length > 0 && attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
        inputs.push(assistantOutput(result.text), userInput(jsonRepairHint(parsed.malformed[0]!.malformed)))
        result = await run()
        ;({ reasoning, rest } = extractReasoning(result.text))
        parsed = partitionToolCalls(parseToolCalls(rest))
      }

      // Mid-task turn that made no tool call and no <final> — nudge once.
      if (midTask && parsed.real.length === 0 && parsed.malformed.length === 0 && !FINAL_RE.test(rest)) {
        inputs.push(assistantOutput(result.text), userInput(MISSING_FINAL_HINT))
        result = await run()
        ;({ reasoning, rest } = extractReasoning(result.text))
        parsed = partitionToolCalls(parseToolCalls(rest))
      }

      const calls = dedupeToolCalls(parsed.real)
      const citations: Citation[] = result.citations
      if (calls.length > 0) {
        const toolCalls: ToolCall[] = calls.map((call) => ({ id: crypto.randomUUID().slice(0, 8), name: call.name, arguments: call.arguments }))
        return { reasoning: reasoning || undefined, text: "", toolCalls, citations, usage: mapUsage(result.usage), finishReason: "tool_calls" }
      }

      const finalMatch = FINAL_RE.exec(rest)
      const parseError = parsed.malformed.length > 0 ? `\n\n${jsonRepairHint(parsed.malformed[0]!.malformed)}` : ""
      const text = `${(finalMatch ? finalMatch[1]! : stripToolCallMarkup(stripFinalMarkup(rest))).trim()}${parseError}`
      return { reasoning: reasoning || undefined, text, toolCalls: [], citations, usage: mapUsage(result.usage), finishReason: "stop" }
    },

    async complete(system: string, prompt: string, signal?: AbortSignal): Promise<string> {
      const result = await streamChat({
        instructions: system,
        inputs: [userInput(prompt)],
        signal,
      }).catch(asProviderError)
      return result.text.trim()
    },

    async completeVision(system: string, prompt: string, images: ImageRef[], signal?: AbortSignal): Promise<string> {
      return completeWithImages(system, prompt, images.map((image) => image.url), signal).catch(asProviderError)
    },
  }
}

function mapUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): StepResult["usage"] {
  return usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : undefined
}
