import { callFunction, functionError } from './functions'

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
 *
 * A stream that ends before the form feed throws. Returning quietly would leave
 * the turn on screen with neither an answer nor a reason, spinning forever,
 * because there is nothing else in the pipeline that can tell it apart from a
 * model that is still thinking.
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

  if (!citationsParsed) {
    throw new Error('The connection closed before the answer started. Ask again.')
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
  const res = await callFunction('recto-chat', { question, notebookId, conversationId })

  // The daily cap is the one failure with an action attached, so it says what
  // the action is rather than repeating the server's `app:key` phrasing.
  if (res.status === 429) {
    throw new Error('Daily limit reached. Sign in with GitHub or Google to raise it.')
  }
  if (!res.ok) throw new Error(await functionError(res))
  if (!res.body) throw new Error('The server sent no answer. Ask again.')

  const returned = res.headers.get('x-conversation-id') ?? conversationId
  await consumeStream(res.body, onToken, onCitations)

  if (!returned) throw new Error('The server did not return a conversation id.')
  return { conversationId: returned }
}
