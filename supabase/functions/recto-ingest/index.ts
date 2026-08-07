import { preflight, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { getCaller, callerClient } from '../_shared/auth.ts'
import { embed } from '../_shared/openai.ts'

interface Chunk {
  content: string
  page: number
  index: number
}

interface Body {
  notebookId: string
  documentId?: string
  name: string
  contentHash: string
  isRtl: boolean
  pageCount: number
  chunks: Chunk[]
  /** True on the batch that completes the document. Promotes it to 'ready'. */
  final: boolean
}

const MAX_CHUNKS_PER_BATCH = 50

/** Must match the halfvec(1536) column. A model that returns anything else has
 *  to be caught here — Postgres would reject the row with a message about
 *  vector dimensions that means nothing to the person who uploaded a PDF. */
const EMBED_DIMS = 1536

/** Postgres SQLSTATEs that mean something specific to the caller. Anything else
 *  is ours to fix, not theirs to read. */
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'

interface PostgrestFailure {
  code?: string
  message?: string
}

/** PostgREST hands back a plain `{ message, details, hint, code }` object, not an
 *  Error. Throwing it reaches the client as the string "[object Object]", so
 *  every database failure is turned into a real Error with a real sentence. */
function dbError(what: string, error: PostgrestFailure): Error {
  return new Error(`Could not ${what}: ${error.message ?? 'the database refused the write.'}`)
}

/** The upstream status is only available inside the message `_shared/openai.ts`
 *  builds, so it is read back out of the text. Rate limits and outages are
 *  transient and say so; a 400 is not, and pretending otherwise sends the
 *  reader round the same loop for nothing. */
function embeddingFailure(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e)

  // Explicitly not retryable, even though it reaches us as a 429. Offering a
  // retry here sends the reader round a loop that can never succeed.
  if ((e as { retryable?: boolean })?.retryable === false) {
    return jsonResponse({ error: message, retryable: false }, 503)
  }

  const status = Number(/\b(\d{3})\b/.exec(message)?.[1] ?? 0)
  if (status === 429 || (status >= 500 && status <= 599)) {
    return jsonResponse(
      {
        error: 'The embedding service is busy right now. Wait a moment and add the file again.',
        retryable: true,
      },
      503,
    )
  }
  return jsonResponse({ error: `Could not embed this document: ${message}` }, 502)
}

function invalid(body: Body): string | null {
  if (typeof body?.notebookId !== 'string' || !body.notebookId) return 'notebookId is required'
  if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required'
  if (typeof body.contentHash !== 'string' || !body.contentHash) return 'contentHash is required'
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return 'chunks must be a non-empty array'
  }
  if (body.chunks.length > MAX_CHUNKS_PER_BATCH) {
    return `batch too large (max ${MAX_CHUNKS_PER_BATCH})`
  }
  // An empty string is rejected by the embeddings endpoint for the whole batch,
  // so one blank chunk would fail all fifty with an opaque upstream message.
  if (body.chunks.some((c) => typeof c?.content !== 'string' || c.content.trim() === '')) {
    return 'every chunk needs non-empty content'
  }
  if (body.chunks.some((c) => !Number.isInteger(c.index))) return 'every chunk needs an index'
  return null
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const caller = await getCaller(req)
    const db = callerClient(caller.jwt).schema('recto')

    let body: Body
    try {
      body = (await req.json()) as Body
    } catch {
      return jsonResponse({ error: 'Request body must be JSON.' }, 400)
    }

    const problem = invalid(body)
    if (problem) return jsonResponse({ error: problem }, 400)

    // First batch creates the document row; later batches reuse its id. It is
    // written as 'indexing' and only promoted once the final batch lands, so a
    // run that stops halfway cannot masquerade as a complete document.
    let documentId = body.documentId
    if (!documentId) {
      const { data, error } = await db
        .from('documents')
        .insert({
          notebook_id: body.notebookId,
          name: body.name,
          content_hash: body.contentHash,
          page_count: body.pageCount,
          is_rtl: body.isRtl === true,
          status: 'indexing',
        })
        .select('id')
        .single()

      if (error?.code === UNIQUE_VIOLATION) {
        return jsonResponse({ error: 'This document is already in the notebook.' }, 409)
      }
      // The notebook was deleted between the upload starting and this batch.
      if (error?.code === FOREIGN_KEY_VIOLATION) {
        return jsonResponse({ error: 'That notebook no longer exists.' }, 404)
      }
      if (error) throw dbError('create the document', error)
      documentId = data.id
    }

    let vectors: number[][]
    try {
      vectors = await embed(body.chunks.map((c) => c.content))
    } catch (e) {
      return embeddingFailure(e)
    }

    // A short or ragged embedding response is the difference between a document
    // that answers questions and one that silently never matches anything. The
    // rows are positional, so a length mismatch would also misalign every
    // remaining chunk with someone else's vector.
    if (vectors.length !== body.chunks.length) {
      return jsonResponse(
        {
          error: `The embedding service returned ${vectors.length} vectors for ${body.chunks.length} passages. Nothing was saved; add the file again.`,
        },
        502,
      )
    }
    if (vectors.some((v) => !Array.isArray(v) || v.length !== EMBED_DIMS)) {
      return jsonResponse(
        { error: `The embedding service returned vectors of the wrong size (expected ${EMBED_DIMS}).` },
        502,
      )
    }

    const rows = body.chunks.map((c, i) => ({
      document_id: documentId,
      content: c.content,
      page: c.page,
      chunk_index: c.index,
      embedding: JSON.stringify(vectors[i]),
    }))

    const { error: insertError } = await db.from('chunks').insert(rows)
    // The document — or the notebook holding it — was deleted mid-upload.
    if (insertError?.code === FOREIGN_KEY_VIOLATION) {
      return jsonResponse({ error: 'That document was removed while it was being added.' }, 404)
    }
    if (insertError) throw dbError('save this batch of passages', insertError)

    if (body.final) {
      const { error: promoteError } = await db
        .from('documents')
        .update({ status: 'ready' })
        .eq('id', documentId)
      if (promoteError) throw dbError('finish indexing the document', promoteError)
    }

    return jsonResponse({
      documentId,
      inserted: rows.length,
      status: body.final ? 'ready' : 'indexing',
    })
  } catch (e) {
    return errorResponse(e)
  }
})

// Quota is deliberately *not* consumed here. Documents are a resource cap, not a
// rate limit: the client checks quotaFor('recto','documents') against its own row
// count before starting, and RLS prevents anything worse than an over-count.
// Consuming a daily counter would leak slots whenever a document is deleted.
