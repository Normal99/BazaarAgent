import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import {
  setStateDir,
  setSetupHint,
  setOpenRouterApp,
  makeHuginProvider,
  makeOpenRouterProvider,
  huginCookie,
  openRouterKey,
  OPENROUTER_DEFAULT_MODEL,
  type LLMProvider,
} from "llm-brain"
import { stateDir } from "../paths.ts"

// Wires the shared brain into this app: its own credential directory, its own
// CLI hints, and the provider order the project settled on — Hugin first
// because it is cheap and internal, GLM-5.3-flash behind it because the
// analysis has to actually work.

let initialised = false

export function initBrain(): void {
  if (initialised) return
  setStateDir(stateDir)
  setSetupHint("hugin", "bazaar provider hugin setup")
  setSetupHint("openrouter", "bazaar provider openrouter setup")
  setOpenRouterApp("BazaarAgent", "https://github.com/Normal99/BazaarAgent")
  initialised = true
}

export interface BrainConfig {
  /** Which provider is tried first. */
  primary: "hugin" | "openrouter"
  openrouterModel: string
  /** Pin vision to a specific provider, once the probe says which can see. */
  visionProvider?: "hugin" | "openrouter"
}

const CONFIG_PATH = () => join(stateDir, "brain.json")
const DEFAULTS: BrainConfig = { primary: "hugin", openrouterModel: OPENROUTER_DEFAULT_MODEL }

export function loadBrainConfig(): BrainConfig {
  try {
    if (!existsSync(CONFIG_PATH())) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(CONFIG_PATH(), "utf8")) as Partial<BrainConfig>
    return {
      primary: raw.primary === "openrouter" ? "openrouter" : "hugin",
      openrouterModel: typeof raw.openrouterModel === "string" && raw.openrouterModel ? raw.openrouterModel : DEFAULTS.openrouterModel,
      visionProvider: raw.visionProvider === "hugin" || raw.visionProvider === "openrouter" ? raw.visionProvider : undefined,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveBrainConfig(patch: Partial<BrainConfig>): BrainConfig {
  const next = { ...loadBrainConfig(), ...patch }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(CONFIG_PATH(), 0o600)
  return next
}

export const huginConfigured = (): boolean => {
  initBrain()
  return huginCookie() !== undefined
}
export const openRouterConfigured = (): boolean => {
  initBrain()
  return openRouterKey() !== undefined
}

/**
 * The provider pair for a task.
 *
 * Only configured providers are offered, so an unconfigured fallback fails
 * loudly at setup rather than silently at 03:00 during a sweep. `visionTask`
 * honours a pin from the probe: if Hugin cannot reliably read car photos, text
 * analysis can stay on it while vision goes to GLM.
 */
export function providersFor(visionTask = false): { primary: LLMProvider; fallback?: LLMProvider } {
  initBrain()
  const config = loadBrainConfig()

  const make = (id: "hugin" | "openrouter"): LLMProvider | undefined => {
    if (id === "hugin") return huginConfigured() ? makeHuginProvider() : undefined
    return openRouterConfigured() ? makeOpenRouterProvider(config.openrouterModel) : undefined
  }

  const preferred = visionTask && config.visionProvider ? config.visionProvider : config.primary
  const other = preferred === "hugin" ? "openrouter" : "hugin"

  const primary = make(preferred) ?? make(other)
  if (!primary)
    throw new Error("No LLM provider is configured. Run `bazaar provider hugin setup` or `bazaar provider openrouter setup`.")

  const fallback = make(primary.id === "hugin" ? "openrouter" : "hugin")
  return { primary, fallback }
}
