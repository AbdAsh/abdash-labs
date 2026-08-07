/** 1536 dims — must match the halfvec(1536) columns every app declares. */
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'

interface EmbeddingItem {
  index: number
  embedding: number[]
}

/** Not transient, however much the HTTP status suggests otherwise. Callers should
 *  surface this as a service problem and must not offer a retry. */
export class EmbeddingUnavailableError extends Error {
  readonly retryable = false
  status = 503
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingUnavailableError'
  }
}

/** Batch-embeds, returning vectors in INPUT order. OpenRouter has no embeddings
 *  endpoint, which is the entire reason OpenAI is in this stack.
 *
 *  `model` is a parameter, not a constant, because RAG Lab benchmarks
 *  `text-embedding-3-large` against the default. Anything other than
 *  `text-embedding-3-small` changes the dimension count, so a caller passing a
 *  different model owns matching its own column width.
 *
 *  Vectors are placed by the response's own `index`, never by array position.
 *  The API returns that field precisely because the order of `data` is not
 *  guaranteed, and this is the most dangerous failure mode in the whole stack:
 *  a reordered response pairs every chunk with a neighbour's vector, so
 *  retrieval returns the wrong passages under confident, correctly-formatted
 *  citations. Nothing downstream — not a type, not a test, not a human reading
 *  the answer — would notice. Recto, RAG Lab and GraphRead all depend on this
 *  function, so the check lives here rather than in any one of them. */
export async function embed(
  texts: string[],
  model: string = DEFAULT_EMBED_MODEL,
): Promise<number[][]> {
  if (texts.length === 0) return []

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!res.ok) {
    const text = await res.text()

    // `insufficient_quota` arrives as a 429, which every sensible retry policy
    // reads as "slow down and try again". It is not that: the account is out of
    // credit and will still be out in an hour. Telling a visitor to wait is
    // advice that can never come true, so it is separated here rather than left
    // for each caller's status-code heuristic to get wrong.
    if (res.status === 429 && text.includes('insufficient_quota')) {
      throw new EmbeddingUnavailableError(
        'The embedding provider account is out of credit. This is a billing problem on ' +
          'our side, not a problem with your document — retrying will not help.',
      )
    }
    throw new Error(`OpenAI embeddings ${res.status}: ${text}`)
  }

  const body = await res.json()
  const items = body?.data as EmbeddingItem[] | undefined

  if (!Array.isArray(items) || items.length !== texts.length) {
    throw new Error(
      `OpenAI returned ${items?.length ?? 0} embeddings for ${texts.length} inputs. ` +
        'Refusing to store a misaligned batch.',
    )
  }

  const out: (number[] | undefined)[] = Array.from({ length: texts.length })
  for (const item of items) {
    const i = item?.index
    if (!Number.isInteger(i) || i < 0 || i >= texts.length) {
      throw new Error(`OpenAI embedding index ${i} is out of range for ${texts.length} inputs.`)
    }
    if (out[i] !== undefined) {
      throw new Error(`OpenAI returned embedding index ${i} twice. Refusing an ambiguous batch.`)
    }
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error(`OpenAI returned no vector for input ${i}.`)
    }
    out[i] = item.embedding
  }

  // A gap means an input silently got no vector. Storing the batch anyway would
  // leave a permanently unsearchable chunk with no error attached to it.
  for (let i = 0; i < out.length; i++) {
    if (out[i] === undefined) throw new Error(`OpenAI returned no embedding for input ${i}.`)
  }

  // Every vector in one batch must share a width, or a later insert fails per-row
  // against a fixed-width column with a message that names the column, not the cause.
  const width = out[0]!.length
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.length !== width) {
      throw new Error(
        `OpenAI returned mixed embedding widths (${width} and ${out[i]!.length}) in one batch.`,
      )
    }
  }

  return out as number[][]
}
