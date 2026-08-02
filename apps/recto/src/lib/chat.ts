import { supabase, SUPABASE_URL } from '@labs/platform'

export interface Citation {
  n: number
  page: number | null
  document: string
  content: string
  similarity: number
}

/**
 * Reads the `\f` protocol inherited from ReadLLM v1: a JSON citations array,
 * one form feed, then answer tokens.
 *
 * The buffering is the whole trick. Citations for eight passages run to several
 * kilobytes and routinely arrive split across reads, so the JSON is accumulated
 * until the form feed is actually seen rather than parsed per read. The
 * `{ stream: true }` decode does the same job one level down, holding back a
 * partial UTF-8 sequence instead of emitting a replacement character — which is
 * what keeps Arabic answers intact.
 */
export async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onToken: (text: string) => void,
  onCitations: (c: Citation[]) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let citationsParsed = false

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    if (!citationsParsed) {
      const ff = buffer.indexOf('\f')
      if (ff === -1) continue
      onCitations(JSON.parse(buffer.slice(0, ff)) as Citation[])
      const rest = buffer.slice(ff + 1)
      buffer = ''
      citationsParsed = true
      if (rest) onToken(rest)
    } else {
      onToken(buffer)
      buffer = ''
    }
  }
}

/**
 * Asks a question of one notebook and streams the answer back.
 *
 * `conversationId` is optional on the way in — the function creates one on the
 * first turn and returns it on the `x-conversation-id` header, so the caller can
 * thread the rest of the exchange onto it.
 */
export async function streamChat(
  question: string,
  notebookId: string,
  conversationId: string | undefined,
  onToken: (t: string) => void,
  onCitations: (c: Citation[]) => void,
): Promise<{ conversationId: string }> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No session yet — sign-in has not finished.')

  const res = await fetch(`${SUPABASE_URL}/functions/v1/recto-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, notebookId, conversationId }),
  })

  if (res.status === 429) {
    throw new Error('Daily limit reached. Sign in with GitHub or Google to raise it.')
  }
  if (!res.ok || !res.body) {
    throw new Error(`chat failed (${res.status}): ${await res.text()}`)
  }

  const returned = res.headers.get('x-conversation-id') ?? conversationId
  await consumeStream(res.body, onToken, onCitations)

  if (!returned) throw new Error('The server did not return a conversation id.')
  return { conversationId: returned }
}
