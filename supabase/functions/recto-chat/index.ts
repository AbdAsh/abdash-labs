import { preflight, errorResponse, corsHeaders } from '../_shared/cors.ts'
import { getCaller, callerClient } from '../_shared/auth.ts'
import { consumeQuota } from '../_shared/quota.ts'
import { embed } from '../_shared/openai.ts'
import { chatStream } from '../_shared/openrouter.ts'

const TOP_K = 8

const SYSTEM = `You answer strictly from the provided context passages. Cite the passages you \
use inline as [n]. If the answer is not present in the context, say you could not find it in \
these documents. Never invent facts.`

interface Match {
  content: string
  page: number | null
  document_name: string
  similarity: number
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const caller = await getCaller(req)
    await consumeQuota(caller.jwt, 'recto', 'messages') // throws 429

    const { question, notebookId, conversationId } = await req.json()
    const db = callerClient(caller.jwt).schema('recto')

    const [queryEmbedding] = await embed([question])
    const { data: matches, error } = await db.rpc('match_chunks', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: TOP_K,
      nb: notebookId,
    })
    if (error) throw error

    const rows = (matches ?? []) as Match[]

    const citations = rows.map((m, i) => ({
      n: i + 1,
      page: m.page,
      document: m.document_name,
      content: m.content,
      similarity: m.similarity,
    }))
    const context = rows
      .map((m, i) => `[${i + 1}] (${m.document_name}, page ${m.page}) ${m.content}`)
      .join('\n\n')

    // Persist the question before streaming, so a dropped connection still
    // leaves a coherent transcript rather than an answer with no question.
    let convoId = conversationId
    if (!convoId) {
      const { data, error: convoError } = await db
        .from('conversations')
        .insert({ notebook_id: notebookId, title: question.slice(0, 80) })
        .select('id')
        .single()
      if (convoError) throw convoError
      convoId = data!.id
    }
    await db.from('messages').insert({
      conversation_id: convoId,
      role: 'user',
      content: question,
    })

    const upstream = await chatStream([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
    ])

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let answer = ''

    const stream = new ReadableStream({
      async start(controller) {
        // The `\f` protocol: citations JSON, one form feed, then answer tokens.
        controller.enqueue(encoder.encode(JSON.stringify(citations) + '\f'))
        const reader = upstream.getReader()
        try {
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const payload = line.slice(6).trim()
              if (payload === '[DONE]') continue
              const delta = JSON.parse(payload).choices?.[0]?.delta?.content ?? ''
              if (delta) {
                answer += delta
                controller.enqueue(encoder.encode(delta))
              }
            }
          }
        } catch (e) {
          controller.enqueue(encoder.encode(`\n[error: ${e instanceof Error ? e.message : e}]`))
        } finally {
          // Written in `finally`, so a mid-stream failure still persists the
          // partial answer rather than losing the turn entirely.
          await db.from('messages').insert({
            conversation_id: convoId,
            role: 'assistant',
            content: answer,
            citations,
          })
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'x-conversation-id': convoId!,
        // Without this the browser hides the header from fetch() on a cross-origin
        // response, and the client can never learn the id of a new conversation.
        'Access-Control-Expose-Headers': 'x-conversation-id',
        Connection: 'keep-alive',
      },
    })
  } catch (e) {
    return errorResponse(e)
  }
})
