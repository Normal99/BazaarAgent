import { z } from "zod"
import type { ImageRef, LLMProvider } from "llm-brain"
import { structured } from "llm-brain"
import type { Store } from "../store.ts"
import { selectImages } from "./images.ts"

// The model's job is not to value the car — comps do that, with measured
// accuracy. Its job is to read what the numbers cannot: the hedging in the ad
// text, and what the photographs show.
//
// Everything is in Norwegian, prompt and output both. The source material is
// Norwegian and the phrases that matter most are exactly the ones that do not
// survive translation — "selges som den er", "må påregnes", "noe å fikse på"
// are hedges with specific weight to a Norwegian buyer.

export const FlagSchema = z.object({
  claim: z.string(),
  /** Which evidence produced it, so the UI can link a photo claim to its photo. */
  source: z.enum(["tekst", "bilde"]),
  /** A quote from the ad, or a description of which photo. */
  evidence: z.string(),
  severity: z.enum(["lav", "middels", "høy"]).optional(),
  imageIndex: z.number().int().min(0).optional(),
})

export const LeverSchema = z.object({
  claim: z.string(),
  evidence: z.string(),
  /** What this is plausibly worth off the asking price, in kroner. */
  estValueNok: z.number().min(0).max(500_000),
})

export const AnalysisSchema = z.object({
  redFlags: z.array(FlagSchema).max(15),
  greenFlags: z.array(FlagSchema).max(15),
  levers: z.array(LeverSchema).max(10),
  /** Odometer read off a dashboard photo, when one is legible. */
  odometerSeenKm: z.number().int().min(0).max(2_000_000).nullable(),
  summaryNo: z.string().max(1200),
})

export type Analysis = z.infer<typeof AnalysisSchema>

const SYSTEM = `Du er en erfaren norsk bilkjøper som vurderer bruktbiler på FINN for en kjøper.

Oppgaven din er å finne det som IKKE står i prisen: feil, slitasje og risiko som gir
grunnlag for å prute, og positive forhold som forsvarer prisen.

Du får annonsetekst, tekniske data og bilder fra annonsen.

Regler:
- Svar KUN med ett JSON-objekt. Ingen tekst før eller etter, ingen markdown.
- Baser deg utelukkende på det du faktisk ser eller leser. Ikke gjett.
- Å finne opp en feil er verre enn å overse en. Et rusthull du innbiller deg gir
  kjøperen et argument som faller sammen når selger viser fram bilen.
- For hvert funn fra et bilde: oppgi imageIndex (0-basert) for bildet det gjelder.
- estValueNok skal være en nøktern norsk reparasjons- eller forhandlingsverdi.
- Se spesielt etter: rust på terskler, hjulbuer og understell; ulik lakk eller
  skjeve panelspalter (skadereparasjon); dekkmønster og bremseskiver; slitasje i
  interiøret målt mot oppgitt kilometerstand; varsellamper i instrumentpanelet;
  lekkasjer eller korrosjon i motorrommet.
- Hvis et dashbordbilde viser kilometerstand: les den av og sett odometerSeenKm.
  Ellers null.

JSON-format:
{
  "redFlags":   [{"claim": "...", "source": "tekst"|"bilde", "evidence": "...", "severity": "lav"|"middels"|"høy", "imageIndex": 0}],
  "greenFlags": [{"claim": "...", "source": "tekst"|"bilde", "evidence": "..."}],
  "levers":     [{"claim": "...", "evidence": "...", "estValueNok": 8000}],
  "odometerSeenKm": null,
  "summaryNo": "..."
}`

export interface AnalyzeInput {
  readonly adId: number
  readonly heading: string
  readonly year?: number
  readonly mileage?: number
  readonly price: number
  readonly fuel?: string
  readonly transmission?: string
  readonly dealerSegment?: string
  readonly description?: string
  readonly equipment?: readonly string[]
  readonly specFields?: Record<string, string>
  readonly imageUrls?: readonly string[]
  /** Registry findings, which carry more weight than anything the seller wrote. */
  readonly registryNotes?: readonly string[]
}

function buildPrompt(input: AnalyzeInput, images: ImageRef[]): string {
  const lines: string[] = [
    `Annonse: ${input.heading}`,
    `Pris: ${input.price.toLocaleString("nb-NO")} kr`,
    input.year ? `Årsmodell: ${input.year}` : "",
    input.mileage !== undefined ? `Kilometerstand oppgitt i annonsen: ${input.mileage.toLocaleString("nb-NO")} km` : "",
    input.fuel ? `Drivstoff: ${input.fuel}` : "",
    input.transmission ? `Girkasse: ${input.transmission}` : "",
    input.dealerSegment ? `Selger: ${input.dealerSegment}` : "",
  ].filter(Boolean)

  if (input.specFields && Object.keys(input.specFields).length > 0) {
    lines.push("", "Tekniske data:")
    for (const [key, value] of Object.entries(input.specFields).slice(0, 30)) lines.push(`  ${key}: ${value}`)
  }
  if (input.registryNotes?.length) {
    lines.push("", "Fra Statens vegvesens register (selger kontrollerer ikke disse):")
    for (const note of input.registryNotes) lines.push(`  - ${note}`)
  }
  if (input.equipment?.length) lines.push("", `Utstyr: ${input.equipment.slice(0, 40).join(", ")}`)
  if (input.description) lines.push("", "Annonsetekst:", input.description.slice(0, 6000))

  lines.push(
    "",
    images.length > 0
      ? `Du får ${images.length} bilder fra annonsen, i rekkefølge med imageIndex 0–${images.length - 1}.`
      : "Ingen bilder er tilgjengelige — vurder kun teksten.",
  )
  return lines.join("\n")
}

export interface AnalyzeOptions {
  readonly primary: LLMProvider
  readonly fallback?: LLMProvider
  readonly store?: Store
  readonly imageCount?: number
  readonly signal?: AbortSignal
}

export interface AnalysisResult {
  readonly analysis: Analysis
  readonly provider: string
  readonly escalated: boolean
  readonly images: ImageRef[]
}

/** Read one listing's text and photos into structured findings. */
export async function analyzeListing(input: AnalyzeInput, options: AnalyzeOptions): Promise<AnalysisResult> {
  const images = selectImages(input.imageUrls ?? [], options.imageCount)
  const run = structured({
    primary: options.primary,
    fallback: options.fallback,
    onCall: options.store ? (record) => options.store!.logLlmCall(record) : undefined,
    timeoutMs: images.length > 0 ? 180_000 : 90_000,
  })

  const result = await run({
    task: images.length > 0 ? "analyze_vision" : "analyze_text",
    ref: String(input.adId),
    system: SYSTEM,
    prompt: buildPrompt(input, images),
    schema: AnalysisSchema,
    images,
    signal: options.signal,
  })

  return { analysis: result.value, provider: result.provider, escalated: result.escalated, images }
}

export { SYSTEM as ANALYSIS_SYSTEM_PROMPT }
