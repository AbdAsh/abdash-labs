import { preflight, jsonResponse, errorResponse, corsHeaders } from '../_shared/cors.ts'
import { getCaller, callerClient } from '../_shared/auth.ts'
import { consumeQuota } from '../_shared/quota.ts'
import { embed } from '../_shared/openai.ts'
import { chatStream } from '../_shared/openrouter.ts'

const TOP_K = 8

/** Comfortably past any real question and well inside the embedding model's
 *  input window, so a runaway paste fails here with a sentence rather than
 *  upstream with a token-count error. */
const MAX_QUESTION_CHARS = 4000

const FOREIGN_KEY_VIOLATION = '23503'

const SYSTEM = `You answer strictly from the provided context passages. Cite the passages you \
use inline as [n]. If the answer is not present in the context, say you could not find it in \
these documents. Never invent facts.`

interface Match {
  content: string
  page: number | null
  document_name: string
  similarity: number
}

interface Citation {
  n: number
  page: number | null
  document: string
  content: string
  similarity: number
}

interface PostgrestFailure {
  code?: string
  message?: string
}

/** PostgREST returns a plain `{ message, details, hint, code }` object rather
 *  than an Error, so throwing it verbatim reaches the browser as the string
 *  "[object Object]". Every database failure becomes a real sentence instead. */
function dbError(what: string, error: PostgrestFailure): Error {
  return new Error(`Could not ${what}: ${error.message ?? 'the database refused the write.'}`)
}

/**
 * A provider that refused, turned into something worth reading.
 *
 * The upstream status is only available inside the message the `_shared`
 * helpers build, so it is read back out of the text. Rate limits and outages
 * are transient and say so; anything else is reported as itself, because a
 * cheerful "try again" for a permanent failure just wastes the reader's time.
 */
function upstreamFailure(e: unknown, busyLine: string): Response {
  const message = e instanceof Error ? e.message : String(e)
  const status = Number(/\b(\d{3})\b/.exec(message)?.[1] ?? 0)
  if (status === 429 || (status >= 500 && status <= 599)) {
    return jsonResponse({ error: busyLine, retryable: true }, 503)
  }
  return jsonResponse({ error: message }, 502)
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const caller = await getCaller(req)

    let payload: { question?: unknown; notebookId?: unknown; conversationId?: unknown }
    try {
      payload = await req.json()
    } catch {
      return jsonResponse({ error: 'Request body must be JSON.' }, 400)
    }

    // Validated before the quota is touched: a malformed request should not
    // cost the caller one of their twenty messages for the day.
    const question = typeof payload.question === 'string' ? payload.question.trim() : ''
    const notebookId = typeof payload.notebookId === 'string' ? payload.notebookId : ''
    const conversationId =
      typeof payload.conversationId === 'string' ? payload.conversationId : undefined

    if (!question) return jsonResponse({ error: 'Ask a question first.' }, 400)
    if (question.length > MAX_QUESTION_CHARS) {
      return jsonResponse(
        { error: `That question is too long (limit ${MAX_QUESTION_CHARS} characters).` },
        400,
      )
    }
    if (!notebookId) return jsonResponse({ error: 'notebookId is required' }, 400)

    await consumeQuota(caller.jwt, 'recto', 'messages') // throws 429

    const db = callerClient(caller.jwt).schema('recto')

    // The question is persisted before anything is streamed, so a dropped
    // connection leaves a coherent transcript rather than an answer with no
    // question. It doubles as the existence check on the notebook: the foreign
    // key rejects a notebook that was deleted while this request was in flight,
    // and it does so before a single paid call is made.
    let convoId = conversationId
    if (!convoId) {
      const { data, error } = await db
        .from('conversations')
        .insert({ notebook_id: notebookId, title: question.slice(0, 80) })
        .select('id')
        .single()
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        return jsonResponse({ error: 'That notebook no longer exists.' }, 404)
      }
      if (error) throw dbError('start this conversation', error)
      convoId = data.id as string
    }

    const { error: questionError } = await db.from('messages').insert({
      conversation_id: convoId,
      role: 'user',
      content: question,
    })
    if (questionError?.code === FOREIGN_KEY_VIOLATION) {
      return jsonResponse({ error: 'That conversation no longer exists.' }, 404)
    }
    if (questionError) throw dbError('save your question', questionError)

    const headers = {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'x-conversation-id': convoId,
      // Without this the browser hides the header from fetch() on a cross-origin
      // response, and the client can never learn the id of a new conversation.
      'Access-Control-Expose-Headers': 'x-conversation-id',
    }

    /** Both exits — streamed and short-circuited — write the assistant turn
     *  through here, so no path can finish without persisting one. */
    const persist = async (content: string, citations: Citation[]) => {
      const { error } = await db.from('messages').insert({
        conversation_id: convoId,
        role: 'assistant',
        content,
        citations,
      })
      // Best effort by design: the conversation may have been deleted while the
      // answer streamed. Losing the write must not also break the response the
      // reader is already looking at.
      if (error) console.error('recto-chat: could not persist the answer', error)
    }

    let queryEmbedding: number[] | undefined
    try {
      ;[queryEmbedding] = await embed([question])
    } catch (e) {
      // The question is already saved, so the transcript keeps it and shows the
      // turn as unanswered rather than losing it along with the explanation.
      return upstreamFailure(e, 'The search service is busy right now. Ask again in a moment.')
    }
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return jsonResponse({ error: 'The search service returned nothing for that question.' }, 502)
    }

    const { data: matches, error: matchError } = await db.rpc('match_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: TOP_K,
      nb: notebookId,
    })
    if (matchError) throw dbError('search this notebook', matchError)

    const rows = (matches ?? []) as Match[]

    // Nothing retrieved means nothing to answer from, so the model is not called
    // at all — it would only be told to say it could not find anything, at the
    // price of a round trip. Say why instead, in terms the reader can act on.
    if (rows.length === 0) {
      const { data: docs } = await db
        .from('documents')
        .select('status')
        .eq('notebook_id', notebookId)
      const all = (docs ?? []) as { status: string }[]
      const ready = all.filter((d) => d.status === 'ready').length
      const answer =
        all.length === 0
          ? 'This notebook has no documents yet, so there is nothing to answer from. Add one on the facing page and ask again.'
          : ready === 0
            ? 'None of this notebook’s documents finished indexing, so there is nothing to search. Remove the unfinished ones and add them again.'
            : 'Nothing in this notebook matched that question closely enough to quote. Try naming a term that appears in the documents.'
      await persist(answer, [])
      return new Response(JSON.stringify([]) + '\f' + answer, { headers })
    }

    const citations: Citation[] = rows.map((m, i) => ({
      n: i + 1,
      page: m.page,
      document: m.document_name,
      content: m.content,
      similarity: m.similarity,
    }))
    const context = rows
      .map((m, i) => `[${i + 1}] (${m.document_name}, page ${m.page ?? 'unknown'}) ${m.content}`)
      .join('\n\n')

    let upstream: ReadableStream<Uint8Array>
    try {
      upstream = await chatStream([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
      ])
    } catch (e) {
      // Refused before a single token: nothing has been streamed, so this can
      // still be an honest HTTP error rather than an apology inside an answer.
      return upstreamFailure(e, 'The model is busy right now. Ask again in a moment.')
    }
    const upstreamReader = upstream.getReader()

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let answer = ''
    let clientGone = false

    const stream = new ReadableStream({
      async start(controller) {
        /** Enqueueing into a stream the browser has walked away from throws.
         *  Returning false instead lets the loop stop pulling — and paying for —
         *  tokens that nobody is going to read. */
        const send = (text: string): boolean => {
          if (clientGone) return false
          try {
            controller.enqueue(encoder.encode(text))
            return true
          } catch {
            clientGone = true
            return false
          }
        }

        // The `\f` protocol: citations JSON, one form feed, then answer tokens.
        send(JSON.stringify(citations) + '\f')

        try {
          let buffer = ''
          reading: for (;;) {
            const { done, value } = await upstreamReader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const payload = line.slice(6).trim()
              if (payload === '[DONE]') continue

              let frame: {
                choices?: { delta?: { content?: string } }[]
                error?: { message?: string }
              }
              try {
                frame = JSON.parse(payload)
              } catch {
                // One unparseable frame is not worth discarding the answer that
                // has already arrived; the provider occasionally emits padding.
                continue
              }
              // Providers report a mid-stream failure as a data frame rather
              // than by closing the connection, so it has to be read, not
              // waited out — otherwise the answer just stops with no reason.
              if (frame.error) {
                throw new Error(frame.error.message ?? 'the model stopped part way through')
              }
              const delta = frame.choices?.[0]?.delta?.content ?? ''
              if (delta) {
                answer += delta
                if (!send(delta)) break reading
              }
            }
          }
        } catch (e) {
          send(`\n\n[The answer stopped early: ${e instanceof Error ? e.message : String(e)}]`)
        } finally {
          // Release the upstream connection whether the answer finished, failed
          // or was abandoned — otherwise the provider keeps generating, and
          // billing, into a stream with no reader.
          await upstreamReader.cancel().catch(() => {})
          await persist(answer, citations)
          if (!clientGone) {
            try {
              controller.close()
            } catch {
              // Already closed by a cancel that raced us here.
            }
          }
        }
      },

      cancel() {
        // The reader navigated away or hit stop. Unblocking the pending read
        // lets `start` fall through to its `finally`, which still saves the
        // partial answer — the turn survives even though the connection did not.
        clientGone = true
        void upstreamReader.cancel().catch(() => {})
      },
    })

    return new Response(stream, { headers })
  } catch (e) {
    return errorResponse(e)
  }
})
