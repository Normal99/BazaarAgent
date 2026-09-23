import { imageVariant } from "../finn/item.ts"
import type { ImageRef } from "llm-brain"

// Listings carry 15–20 photos. Sending all of them at full size is slow and
// pointless: finncdn serves resized variants by path substitution, and 640w
// (~28 KB against ~181 KB for 1600w) is plenty to see rust, panel gaps, tyre
// wear or a warning light. The cap exists to keep latency sane rather than to
// save money — at GLM-5.3-flash's $0.15/M the cost is a rounding error.

export const DEFAULT_IMAGE_COUNT = 8

/**
 * Pick which photos to send.
 *
 * Sellers order photos conventionally: exteriors first, then interior, then
 * details and damage. Taking the first N would therefore get eight near-identical
 * three-quarter shots of the same corner. Taking the first two and then spreading
 * the rest across the album covers exterior, interior, dash and whatever was
 * photographed last — which is where sellers put the things they photographed
 * because they had to.
 */
export function selectImages(urls: readonly string[], count = DEFAULT_IMAGE_COUNT, size: "640w" | "1280w" = "640w"): ImageRef[] {
  if (urls.length === 0) return []
  if (urls.length <= count) return urls.map((url) => ({ url: imageVariant(url, size), detail: "low" as const }))

  const picked: string[] = [urls[0]!]
  if (count > 1 && urls.length > 1) picked.push(urls[1]!)

  const remaining = count - picked.length
  const rest = urls.slice(2)
  const step = rest.length / remaining
  for (let i = 0; i < remaining; i++) {
    const candidate = rest[Math.floor(i * step)]
    if (candidate && !picked.includes(candidate)) picked.push(candidate)
  }

  return picked.slice(0, count).map((url) => ({ url: imageVariant(url, size), detail: "low" as const }))
}
