/**
 * The embedding client for resolution pass 2.
 *
 * GraphRead does not own an embedding proxy. It calls RAG Lab's `raglab-embed`
 * — same OpenAI key, same model, one function to secure and one to maintain.
 * Standing up a second proxy would be the exact copy-paste drift the monorepo
 * exists to prevent.
 */

import { supabase } from '@labs/platform'
import type { EmbedFn } from './resolve'

/** Must match the dimension the rest of the platform stores: halfvec(1536). */
export const EMBED_MODEL = 'text-embedding-3-small'

/**
 * `raglab-embed` charges the `raglab:runs` quota when a request arrives with no
 * `runId`. GraphRead always sends one, because its own spend is already metered
 * by `graphread:extractions` and a resolution pass must not silently consume a
 * user's RAG Lab benchmark allowance.
 */
const RUN_ID_PREFIX = 'graphread'

let runCounter = 0

export function newEmbedRunId(): string {
  runCounter += 1
  return `${RUN_ID_PREFIX}-${Date.now().toString(36)}-${runCounter}`
}

export const embedTexts: EmbedFn = async (texts) => {
  if (texts.length === 0) return []

  const { data, error } = await supabase.functions.invoke<{ vectors: number[][] }>(
    'raglab-embed',
    { body: { texts, model: EMBED_MODEL, runId: newEmbedRunId() } },
  )
  if (error) throw error

  const vectors = data?.vectors
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(
      `raglab-embed returned ${vectors?.length ?? 0} vectors for ${texts.length} texts`,
    )
  }
  return vectors
}
