// Text-based tool-calling protocol for Hugin.
//
// Hugin's /api/chat has no native function calling (probed live for HuginCode:
// config.tools accepts only web_search/datasource, a function tool 500s in
// every shape). So the agent loop is emulated in plain text: tool definitions
// are rendered into a manifest, the model is told to emit <tool_call> blocks,
// and this module parses them back out. Ported from HuginCode's
// packages/llm/src/protocols/utils/hugin-text-protocol.ts — same wire contract,
// trimmed to what AgentMark's loop uses. Dependency-free on purpose.

export const TOOL_CALL_OPEN = "<tool_call>"
export const TOOL_CALL_CLOSE = "</tool_call>"
export const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

export const TOOL_RESULT_CLOSE = "</tool_result>"
export const toolResultOpen = (id: string, name: string) => `<tool_result id="${id}" name="${name}">`
export const toolResultTag = (id: string, name: string, text: string) => `${toolResultOpen(id, name)}\n${text}\n${TOOL_RESULT_CLOSE}`

// Marks a turn as a deliberate, complete stop with no further tool calls — the
// structural counterpart to <tool_call>. A mid-task turn with neither tag is
// an interrupted turn, not an answer (see HuginCode's history: lexically
// detecting "narrated an action but never called a tool" was a losing game).
export const FINAL_OPEN = "<final>"
export const FINAL_CLOSE = "</final>"
export const FINAL_RE = /<final>([\s\S]*?)<\/final>/i

// Hugin never streams a native reasoning channel. Simulated best-effort via a
// <lemma> header the model already reached for unprompted in HuginCode's
// trials. Not enforced — a turn without one just has empty reasoning.
export const REASONING_RE = /<(lemma|thinking)>\s*([\s\S]*?)\s*<\/\1>/g

export const extractReasoning = (text: string): { reasoning: string; rest: string } => {
  const parts: string[] = []
  const seen = new Set<string>()
  const rest = text.replace(REASONING_RE, (_match, _tag: string, inner: string) => {
    const trimmed = inner.trim()
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed)
      parts.push(trimmed)
    }
    return ""
  })
  return { reasoning: parts.join("\n\n"), rest }
}

export const stripFinalMarkup = (text: string): string => text.split(FINAL_OPEN).join("").split(FINAL_CLOSE).join("")

/** Strip tool-call markup for display — handles an unclosed trailing opener that still parsed as a real call. */
export const stripToolCallMarkup = (text: string): string => {
  const withoutClosed = text.replace(TOOL_CALL_RE, "")
  const openerIndex = withoutClosed.lastIndexOf(TOOL_CALL_OPEN)
  if (openerIndex === -1) return withoutClosed
  const tail = withoutClosed.slice(openerIndex + TOOL_CALL_OPEN.length).replace(TOOL_CALL_CLOSE, "").trim()
  return tail.length > 0 ? withoutClosed.slice(0, openerIndex) : withoutClosed
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export const toolManifest = (tools: ReadonlyArray<ToolDefinition>) =>
  tools.map((tool) => `- ${tool.name}: ${tool.description}\n  schema: ${JSON.stringify(tool.inputSchema)}`).join("\n")

export const toolCallTag = (name: string, input: unknown) =>
  `${TOOL_CALL_OPEN}\n${JSON.stringify({ name, arguments: input })}\n${TOOL_CALL_CLOSE}`

export type ParsedToolCall = { readonly name: string; readonly arguments: unknown } | { readonly malformed: string }

// Tool calls whose payload is a large free-form body (a full note, an email).
// Brace-balancing repair CAN make truncated JSON parse, but the recovered
// content is still silently cut short — worse than a clean failure. Balancing
// repair is refused for these; the trailing-comma fix still applies.
export const LARGE_CONTENT_TOOLS = new Set(["create_note", "draft_email"])

const repairTruncatedJson = (text: string): string | undefined => {
  const stack: Array<"{" | "["> = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{" || ch === "[") stack.push(ch)
    else if (ch === "}" && stack.at(-1) === "{") stack.pop()
    else if (ch === "]" && stack.at(-1) === "[") stack.pop()
  }
  if (!inString && stack.length === 0) return undefined
  let suffix = inString ? '"' : ""
  for (let i = stack.length - 1; i >= 0; i--) suffix += stack[i] === "{" ? "}" : "]"
  return text + suffix
}

const parseCallRecord = (parsed: unknown): { name: string; arguments: unknown } | undefined => {
  if (parsed === null || typeof parsed !== "object") return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.name !== "string") return undefined
  return { name: record.name, arguments: record.arguments ?? {} }
}

const tryParseCall = (raw: string): ParsedToolCall | undefined => {
  try {
    return parseCallRecord(JSON.parse(raw))
  } catch {
    // fall through to repair attempts
  }

  const withoutTrailingCommas = raw.replace(/,(\s*[}\]])/g, "$1")
  try {
    const repaired = parseCallRecord(JSON.parse(withoutTrailingCommas))
    if (repaired) return repaired
  } catch {
    // fall through to truncation repair
  }

  const balanced = repairTruncatedJson(withoutTrailingCommas)
  if (balanced !== undefined) {
    try {
      const repaired = parseCallRecord(JSON.parse(balanced))
      if (repaired && !LARGE_CONTENT_TOOLS.has(repaired.name)) return repaired
    } catch {
      // give up — caller wraps as malformed
    }
  }

  return undefined
}

export const parseToolCalls = (text: string): ParsedToolCall[] => {
  const calls: ParsedToolCall[] = []
  TOOL_CALL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOOL_CALL_RE.exec(text))) {
    calls.push(tryParseCall(match[1] ?? "") ?? { malformed: match[1] ?? "" })
  }
  if (calls.length === 0 && text.includes(TOOL_CALL_OPEN)) {
    const tail = text
      .slice(text.lastIndexOf(TOOL_CALL_OPEN) + TOOL_CALL_OPEN.length)
      .replace(TOOL_CALL_CLOSE, "")
      .trim()
    if (tail.length > 0) calls.push(tryParseCall(tail) ?? { malformed: tail })
  }
  return calls
}

export const isValidToolCall = (call: ParsedToolCall): call is { readonly name: string; readonly arguments: unknown } =>
  "name" in call

export const partitionToolCalls = (calls: ReadonlyArray<ParsedToolCall>) => {
  const real: Array<{ name: string; arguments: unknown }> = []
  const malformed: Array<{ malformed: string }> = []
  for (const call of calls) {
    if (isValidToolCall(call)) real.push(call)
    else malformed.push({ malformed: call.malformed })
  }
  return { real, malformed }
}

/** Collapse exact-duplicate calls emitted within one turn (same name + arguments). None can react to another's result yet, so extras are waste at best and a doubled side effect at worst. */
export const dedupeToolCalls = (calls: ReadonlyArray<{ name: string; arguments: unknown }>): Array<{ name: string; arguments: unknown }> => {
  const seen = new Set<string>()
  const result: Array<{ name: string; arguments: unknown }> = []
  for (const call of calls) {
    const key = `${call.name} ${JSON.stringify(call.arguments)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(call)
  }
  return result
}

export const guessToolName = (raw: string): string | undefined => raw.match(/"name"\s*:\s*"([^"]+)"/)?.[1]

export const jsonRepairHint = (raw: string) =>
  `[tool-call parse error] The previous <tool_call> block was not valid JSON and was not executed: ${raw.slice(0, 200)}\nRe-emit it as a single <tool_call>{"name": "...", "arguments": {...}}</tool_call> block containing valid JSON. A newline inside a string value needs exactly one backslash-n — do not double-escape.`

export const MISSING_FINAL_HINT =
  "This turn made no tool calls and didn't wrap its answer in <final>...</final>, which is required once you are mid-task. If you still need to act, emit the <tool_call> now. If you are done, put your complete answer in a single <final>...</final> block."

export const TOOL_PROTOCOL = `You have access to tools, but this connection has no native function-calling — tools must be invoked as plain text.

MANDATORY FORMAT: in any turn where you call a tool, open with exactly one <lemma>...</lemma> block — 1-3 concise sentences of your reasoning: what you are about to do and why. This is a strict format requirement.

After that single reasoning block, output one <tool_call> block per tool call and nothing else:
<tool_call>
{"name": "<tool name>", "arguments": { ... }}
</tool_call>
Do not wrap it in a code fence or add commentary between the blocks.

Batch independent tool calls together in the SAME turn rather than one per turn — every extra turn is a full round trip. Never emit the exact same tool call (same name, same arguments) twice in one turn.

Tool results come back to you on the next turn wrapped in <tool_result id="..." name="...">...</tool_result> tags.

MANDATORY: if answering accurately needs information you do not already have — a file's contents, a search result, the current timetable — you MUST call the appropriate tool and use its real result. Never guess or answer from general knowledge, and never claim to have checked something you did not call a tool for.

MANDATORY: every turn ends in one of exactly two ways — one or more <tool_call> blocks, or a single <final>...</final> block wrapping your complete answer to the user. Plain prose describing what you are about to do is not a valid stopping point.`

export const AGENT_POLICY_NOTES = `Working notes:
- Some tools only PROPOSE an action (draft_email, create_note, add_calendar_event, send_teams_message). Calling them does not perform the action — it queues a proposal the user reviews and approves. Say clearly in your final answer what you proposed and that it is awaiting approval. Never claim an email was sent, a message was sent, or an event was created.
- draft_email only ever produces a Gmail draft the user sends themselves. send_teams_message, once approved, actually delivers — only use it when the user explicitly asked to send a Teams message to a named person.
- Read tools (search_workspace, get_item, workspace_digest, timetable, teams_messages) run immediately and return real data. Prefer a targeted search_workspace over asking the user for information that is already in the workspace.
- Load a self-documenting result (a digest, a --help style listing) once per task; re-loading the same thing rarely reveals anything new and spends context.
- When you need a decision only the user can make (which of several valid approaches, missing information a tool cannot supply), stop with a <final> block that asks — do not guess.`
