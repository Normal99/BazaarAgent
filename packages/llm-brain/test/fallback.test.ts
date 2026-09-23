import { expect, test } from "bun:test"
import { z } from "zod"
import { extractJson, structured, StructuredError, type CallRecord } from "../src/fallback.ts"
import { ProviderError, type ImageRef, type LLMProvider } from "../src/provider.ts"

const Schema = z.object({ verdict: z.string(), score: z.number() })

/** A provider that replays canned replies, one per call, and counts what it saw. */
function fake(id: string, replies: Array<string | Error>, opts: { vision?: boolean } = {}): LLMProvider & { calls: number; sawImages: number } {
  let index = 0
  const provider = {
    id,
    model: `${id}-model`,
    vision: opts.vision ?? true,
    calls: 0,
    sawImages: 0,
    async step(): Promise<never> {
      throw new Error("not used")
    },
    async complete(): Promise<string> {
      provider.calls++
      const next = replies[Math.min(index++, replies.length - 1)]!
      if (next instanceof Error) throw next
      return next
    },
    async completeVision(_s: string, _p: string, images: ImageRef[]): Promise<string> {
      provider.sawImages = images.length
      return provider.complete()
    },
  }
  return provider as LLMProvider & { calls: number; sawImages: number }
}

const ask = (primary: LLMProvider, fallback: LLMProvider | undefined, log: CallRecord[], extra = {}) =>
  structured({ primary, fallback, onCall: (r) => log.push(r), repairAttempts: 1, ...extra })({
    task: "analyze",
    ref: "477115867",
    system: "s",
    prompt: "p",
    schema: Schema,
  })

test("extractJson survives fences, prose, and braces inside strings", () => {
  expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  expect(extractJson('Her er analysen:\n{"a":1}\nHåper det hjelper!')).toEqual({ a: 1 })
  expect(extractJson('{"note":"selges {som den er}","a":2}')).toEqual({ note: "selges {som den er}", a: 2 })
  expect(extractJson('{"nested":{"deep":true}}')).toEqual({ nested: { deep: true } })
  expect(extractJson('{"escaped":"a \\" brace } here","a":3}')).toEqual({ escaped: 'a " brace } here', a: 3 })
  expect(extractJson("no json at all")).toBeUndefined()
  expect(extractJson('{"unclosed":')).toBeUndefined()
})

test("a valid first reply never touches the fallback", async () => {
  const primary = fake("hugin", ['{"verdict":"ok","score":7}'])
  const secondary = fake("openrouter", ['{"verdict":"nope","score":0}'])
  const log: CallRecord[] = []

  const result = await ask(primary, secondary, log)

  expect(result.value).toEqual({ verdict: "ok", score: 7 })
  expect(result.provider).toBe("hugin")
  expect(result.escalated).toBe(false)
  expect(secondary.calls).toBe(0)
  expect(log).toHaveLength(1)
  expect(log[0]!.ok).toBe(true)
})

test("malformed JSON is repaired on the same provider before escalating", async () => {
  const primary = fake("hugin", ["not json at all", '{"verdict":"ok","score":7}'])
  const secondary = fake("openrouter", ['{"verdict":"fallback","score":1}'])
  const log: CallRecord[] = []

  const result = await ask(primary, secondary, log)

  expect(result.provider).toBe("hugin")
  expect(result.escalated).toBe(false)
  expect(primary.calls).toBe(2)
  expect(secondary.calls).toBe(0)
  expect(log[0]).toMatchObject({ ok: false, escalateReason: "no_json", attempt: 1 })
  expect(log[1]).toMatchObject({ ok: true, attempt: 2 })
})

test("schema-valid JSON of the wrong shape still escalates", async () => {
  // The failure mode that matters: HTTP 200, parseable JSON, wrong contents.
  const primary = fake("hugin", ['{"verdict":"ok","score":"seven"}'])
  const secondary = fake("openrouter", ['{"verdict":"ok","score":7}'])
  const log: CallRecord[] = []

  const result = await ask(primary, secondary, log)

  expect(result.value).toEqual({ verdict: "ok", score: 7 })
  expect(result.provider).toBe("openrouter")
  expect(result.escalated).toBe(true)
  expect(result.reason).toBe("schema_invalid")
  expect(primary.calls).toBe(2) // first try + one repair
  expect(log.filter((r) => r.escalateReason === "schema_invalid")).toHaveLength(2)
  expect(log.at(-1)).toMatchObject({ provider: "openrouter", ok: true })
})

test("a transport error escalates immediately without wasting a repair", async () => {
  const primary = fake("hugin", [new ProviderError("network", "gateway down")])
  const secondary = fake("openrouter", ['{"verdict":"ok","score":3}'])
  const log: CallRecord[] = []

  const result = await ask(primary, secondary, log)

  expect(result.provider).toBe("openrouter")
  expect(primary.calls).toBe(1)
  expect(log[0]).toMatchObject({ escalateReason: "network", detail: "gateway down" })
})

test("a provider that cannot see images is skipped, not asked", async () => {
  const blind = fake("hugin", ['{"verdict":"ok","score":1}'], { vision: false })
  const seeing = fake("openrouter", ['{"verdict":"saw it","score":9}'])
  const log: CallRecord[] = []

  const result = await structured({ primary: blind, fallback: seeing, onCall: (r) => log.push(r) })({
    task: "vision",
    system: "s",
    prompt: "p",
    schema: Schema,
    images: [{ url: "https://images.finncdn.no/x" }, { url: "https://images.finncdn.no/y" }],
  })

  expect(blind.calls).toBe(0)
  expect(seeing.sawImages).toBe(2)
  expect(result.provider).toBe("openrouter")
  expect(log[0]).toMatchObject({ escalateReason: "vision_unsupported", provider: "hugin" })
})

test("images reach a vision-capable primary", async () => {
  const primary = fake("hugin", ['{"verdict":"rust on sill","score":4}'])
  const log: CallRecord[] = []

  const result = await structured({ primary, onCall: (r) => log.push(r) })({
    task: "vision",
    system: "s",
    prompt: "p",
    schema: Schema,
    images: [{ url: "https://images.finncdn.no/a" }],
  })

  expect(primary.sawImages).toBe(1)
  expect(result.value.verdict).toBe("rust on sill")
  expect(log[0]!.imageCount).toBe(1)
})

test("both providers failing raises StructuredError carrying the last reply", async () => {
  const primary = fake("hugin", ["garbage"])
  const secondary = fake("openrouter", ["also garbage"])
  const log: CallRecord[] = []

  await expect(ask(primary, secondary, log)).rejects.toThrow(StructuredError)
  expect(log).toHaveLength(4) // 2 attempts each
  expect(log.every((r) => !r.ok)).toBe(true)
})

test("with no fallback configured the primary's failure is final", async () => {
  const primary = fake("hugin", ["garbage"])
  const log: CallRecord[] = []

  await expect(ask(primary, undefined, log)).rejects.toThrow(/Could not get a valid analyze response/)
  expect(log).toHaveLength(2)
})

test("a caller abort propagates instead of escalating", async () => {
  const controller = new AbortController()
  controller.abort()
  const primary = fake("hugin", [new ProviderError("network", "aborted")])
  const secondary = fake("openrouter", ['{"verdict":"ok","score":1}'])

  await expect(
    structured({ primary, fallback: secondary })({
      task: "analyze",
      system: "s",
      prompt: "p",
      schema: Schema,
      signal: controller.signal,
    }),
  ).rejects.toThrow()
  expect(secondary.calls).toBe(0)
})
