/**
 * Pre-run cost estimate.
 *
 * Extraction is per-chunk LLM work, so the user sees the bill before it is
 * incurred. Chunking is free and happens client-side, so by the time this runs
 * the exact chunk list is already known — the only estimated quantities are
 * tokens per character and output length.
 */

/** Hard ceiling on document length, matching the spec's abuse controls. */
export const MAX_PAGES = 60

/** Roughly four characters to a token for English prose. */
const CHARS_PER_TOKEN = 4

/** The system prompt goes out with every chunk. Measured, not guessed. */
const PROMPT_OVERHEAD_TOKENS = 360

/** A dense chunk yields on the order of a dozen entities and relations. */
const OUTPUT_TOKENS_PER_CHUNK = 400

/**
 * MODEL_CHEAP rates per million tokens. These track whatever `MODEL_CHEAP` is
 * set to and are the one thing here that goes stale silently — if the estimate
 * starts disagreeing with the OpenRouter bill, this is the place to look.
 */
const USD_PER_M_INPUT = 0.15
const USD_PER_M_OUTPUT = 0.6

export interface CostEstimate {
  pages: number
  chunks: number
  inputTokens: number
  outputTokens: number
  usd: number
  overPageCap: boolean
}

export function estimateCost(chunkTexts: string[], pageCount: number): CostEstimate {
  const chunks = chunkTexts.length
  const pages = Math.max(0, Math.floor(pageCount) || 0)

  const contentTokens = chunkTexts.reduce(
    (sum, t) => sum + Math.ceil((t?.length ?? 0) / CHARS_PER_TOKEN),
    0,
  )
  const inputTokens = contentTokens + chunks * PROMPT_OVERHEAD_TOKENS
  const outputTokens = chunks * OUTPUT_TOKENS_PER_CHUNK

  const usd =
    (inputTokens / 1_000_000) * USD_PER_M_INPUT + (outputTokens / 1_000_000) * USD_PER_M_OUTPUT

  return {
    pages,
    chunks,
    inputTokens,
    outputTokens,
    usd,
    overPageCap: pages > MAX_PAGES,
  }
}

/** Rounds to cents, but never rounds a real charge down to "free". */
export function formatUsd(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.005) return '< $0.01'
  return `$${usd.toFixed(2)}`
}
