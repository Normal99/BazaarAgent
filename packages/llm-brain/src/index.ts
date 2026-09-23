// Public surface of the shared brain. Host apps import from here and nothing
// else, so the internal file layout stays free to move.

export {
  ProviderError,
  type AgentMessage,
  type Citation,
  type ImageRef,
  type LLMProvider,
  type StepInput,
  type StepResult,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "./provider.ts"

export { setStateDir, stateDir, statePath, setSetupHint } from "./state.ts"

export { makeHuginProvider } from "./providers/hugin.ts"
export {
  makeOpenRouterProvider,
  configureOpenRouter,
  openRouterKey,
  openRouterStatus,
  listModels,
  setOpenRouterApp,
  DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL,
  type CatalogueModel,
} from "./providers/openrouter.ts"

export {
  complete as huginComplete,
  completeWithImage as huginCompleteWithImage,
  completeWithImages as huginCompleteWithImages,
  configure as configureHugin,
  status as huginStatus,
  resolveCookie as huginCookie,
  streamChat as huginStreamChat,
  HuginError,
  type HuginInput,
  type HuginResult,
  type StreamOptions as HuginStreamOptions,
} from "./hugin-client.ts"

export {
  structured,
  extractJson,
  StructuredError,
  type CallRecord,
  type EscalateReason,
  type StructuredOptions,
  type StructuredRequest,
  type StructuredResult,
} from "./fallback.ts"

export * as toolProtocol from "./tool-protocol.ts"
