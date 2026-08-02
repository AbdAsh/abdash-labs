import type { Embedder } from './engine'

/**
 * Client for the `raglab-embed` Edge Function — the only surface in this app that
 * spends money, and the only one that talks to a server during a run.
 */

/** Matches the caps enforced server-side; exceeding them is a 400, not a truncation. */
export const MAX_BATCH_TEXTS = 200
export const MAX_BATCH_CHARS = 400_000

export interface EmbedRequest {
  texts: string[]
  model: string
  runId?: string
}

export interface EmbedResponse {
  vectors: number[][]
  runId: string
}

export type EmbedTransport = (body: EmbedRequest) => Promise<EmbedResponse>

export class EmbedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'EmbedError'
  }
}

/**
 * Splits a request into batches the function will accept.
 *
 * Both caps matter: 200 texts keeps a single OpenAI call inside its own limits,
 * and 400,000 characters keeps the Edge Function inside its 150 s wall clock. A
 * batch is closed when adding the next text would breach either one.
 */
export function planBatches(
  texts: string[],
  maxTexts = MAX_BATCH_TEXTS,
  maxChars = MAX_BATCH_CHARS,
): number[][] {
  const batches: number[][] = []
  let current: number[] = []
  let chars = 0

  for (let i = 0; i < texts.length; i++) {
    const length = texts[i]!.length
    if (length > maxChars) {
      throw new EmbedError(
        `Text ${i} is ${length} characters, above the ${maxChars} per-request cap. `
        + 'Use a smaller chunk size.',
        400,
      )
    }
    if (current.length > 0 && (current.length >= maxTexts || chars + length > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(i)
    chars += length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function httpTransport(body: EmbedRequest): Promise<EmbedResponse> {
  // Lazy so the pure batching tests never construct a Supabase client, which
  // would demand VITE_SUPABASE_URL at import time.
  const { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } = await import('@labs/platform')
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new EmbedError('No session. Reload the page to start one.', 401)

  const res = await fetch(`${SUPABASE_URL}/functions/v1/raglab-embed`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text()
    let message = detail
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? detail
    } catch {
      // Non-JSON error body; the raw text is the best message available.
    }
    throw new EmbedError(message || `raglab-embed failed with ${res.status}`, res.status)
  }
  return (await res.json()) as EmbedResponse
}

/**
 * An embedder scoped to one benchmark run.
 *
 * The run identity lives in this closure rather than in a module global because
 * quota is charged per *run*, not per request: the first batch goes out without a
 * `runId`, the function charges `raglab:runs` and mints one, and every later batch
 * carries it. Twelve configurations therefore cost one run, not twelve.
 */
export function createEmbedder(transport: EmbedTransport = httpTransport): Embedder {
  let runId: string | undefined

  return async function embed(texts: string[], model: string): Promise<number[][]> {
    if (texts.length === 0) return []

    const out: number[][] = Array.from({ length: texts.length })
    for (const batch of planBatches(texts)) {
      const res = await transport({
        texts: batch.map((i) => texts[i]!),
        model,
        ...(runId ? { runId } : {}),
      })
      if (res.vectors.length !== batch.length) {
        throw new EmbedError(
          `raglab-embed returned ${res.vectors.length} vectors for ${batch.length} texts. `
          + 'Refusing to score a misaligned batch.',
          502,
        )
      }
      // Scatter back to original positions: a batch boundary must never reorder
      // vectors relative to their chunks, or every score silently shifts.
      batch.forEach((originalIndex, j) => {
        out[originalIndex] = res.vectors[j]!
      })
      runId ??= res.runId
    }
    return out
  }
}

/** One-shot embedding outside a benchmark. Charges a full run of quota. */
export async function embedTexts(texts: string[], model: string): Promise<number[][]> {
  return createEmbedder()(texts, model)
}
