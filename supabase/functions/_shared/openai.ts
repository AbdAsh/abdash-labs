/** 1536 dims — must match the halfvec(1536) columns every app declares. */
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'

/** Batch-embeds in input order. OpenRouter has no embeddings endpoint, which is
 *  the entire reason OpenAI is in this stack.
 *
 *  `model` is a parameter, not a constant, because RAG Lab benchmarks
 *  `text-embedding-3-large` against the default. Anything other than
 *  `text-embedding-3-small` changes the dimension count, so a caller passing a
 *  different model owns matching its own column width. */
export async function embed(
  texts: string[], model: string = DEFAULT_EMBED_MODEL,
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
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return (body.data as { embedding: number[] }[]).map((d) => d.embedding)
}
