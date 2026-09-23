import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

// Where the providers keep their credentials. This used to be AgentMark's
// `paths.ts` (`stateDir` / `huginConfigPath`), which was the only thing tying
// this layer to that app. Consumers inject their own directory once at startup
// instead, so AgentMark keeps reading ~/.agentmark and BazaarAgent reads
// ~/.bazaaragent without either knowing about the other.

let dir = join(homedir(), ".llm-brain")

export function setStateDir(next: string): void {
  dir = next
}

export function stateDir(): string {
  return dir
}

/** Path inside the state directory, with the directory created owner-only on demand. */
export function statePath(file: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, file)
}

// Each app has its own CLI, so "how do I fix this?" differs. The providers used
// to hardcode `agentmark provider hugin setup`; now the host app says what to
// print and the shared layer stays app-agnostic.

const hints: Record<string, string> = {}

export function setSetupHint(provider: "hugin" | "openrouter", command: string): void {
  hints[provider] = command
}

/** " Run `x`." when the host app registered a hint, otherwise "". */
export function setupHint(provider: "hugin" | "openrouter"): string {
  const command = hints[provider]
  return command ? ` Run \`${command}\`.` : ""
}
