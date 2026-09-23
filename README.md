# BazaarAgent

Agent for exploring marketplaces like Finn.no and giving back suggestions and
recommendations to watchlists.

It watches your saved searches for cars worth buying, values each one against
real comparable listings, and tells you two numbers you can act on: **what it's
worth** and **what to haggle down to**.

The case it's built around: a car slightly over budget isn't a car you should
discard. If the asking price is above your budget but the *defensible* price is
below it, that's the most interesting listing on the page — a deal you can talk
your way into. Those get flagged, with the argument written out for you.

## Status

Early. Phase 0 (the shared LLM layer) is done; ingestion, valuation and the UI
are in progress. See `packages/` for what exists.

## Layout

```
packages/llm-brain/   Provider-neutral LLM layer — Hugin + OpenRouter, vision,
                      and quality-gated fallback. Shared with other projects.
packages/agent/       The finn.no watcher: ingestion, valuation, haggling, UI.
```

## The LLM layer

Two providers behind one contract (`LLMProvider`):

- **Hugin** — an internal gateway. No native tool calling, so it uses a text
  `<tool_call>` protocol with malformed-JSON repair built in. Cheap, which makes
  it the default.
- **OpenRouter** — native tool calling, any model. Defaults to
  `z-ai/glm-5.3-flash` (vision-capable, 1.3M context, $0.15/M prompt).

Both can see images. The two want opposite things and the contract absorbs it:
OpenRouter takes a remote URL straight through, Hugin needs bytes inline and so
fetches and base64-encodes first. Callers just pass `ImageRef { url }`.

### Fallback is gated on the parsed value, not the status code

The realistic failure of a gateway without structured output isn't an HTTP
error — it's a 200 carrying prose, a half-closed brace, or JSON whose shape is
subtly wrong. So `structured()` only counts a reply as success once it survives
`schema.parse`:

```ts
const analyze = structured({
  primary: makeHuginProvider(),
  fallback: makeOpenRouterProvider(OPENROUTER_DEFAULT_MODEL),
  onCall: (record) => db.logLlmCall(record),
})

const { value, provider, escalated } = await analyze({
  task: "analyze",
  ref: adId,
  system: SYSTEM,
  prompt,
  schema: AnalysisSchema,
  images: photos.map((url) => ({ url, detail: "low" })),
})
```

Order is primary → repair retry on the same provider → fallback. Transport
errors skip the repair, since rephrasing won't fix a dead socket. Every attempt
is reported through `onCall`, which is how "is the cheap provider actually good
enough?" gets answered from logged data rather than from an impression.

### Using it from another project

The package is path-independent — inject the credential directory once:

```ts
import { setStateDir, setSetupHint } from "llm-brain"

setStateDir(join(homedir(), ".myapp"))
setSetupHint("hugin", "myapp provider hugin setup")
```

## On finn.no

finn.no publishes no official API. This reads the same server-rendered pages a
browser does, at a personal scale: requests are serial, rate-limited, cached, and
restricted to the `/mobility/*` paths their `robots.txt` explicitly allows.

Be aware that the same `robots.txt` opens with a blanket *"Crawling FINN.no is
prohibited unless you have written permission"*, and their terms bar systematic
automated use. That contradicts the `Allow:` lines further down the same file.
This project resolves it in favour of polite, personal-scale, human-equivalent
traffic — but go in knowing the tension exists rather than discovering it later.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
```
