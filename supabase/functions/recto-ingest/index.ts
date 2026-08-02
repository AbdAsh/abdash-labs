import { preflight, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { getCaller, callerClient } from '../_shared/auth.ts'
import { embed } from '../_shared/openai.ts'

interface Body {
  notebookId: string
  documentId?: string
  name: string
  contentHash: string
  isRtl: boolean
  pageCount: number
  chunks: { content: string; page: number; index: number }[]
}

const MAX_CHUNKS_PER_BATCH = 50

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const caller = await getCaller(req)
    const db = callerClient(caller.jwt).schema('recto')
    const body = (await req.json()) as Body

    if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
      return jsonResponse({ error: 'chunks must be a non-empty array' }, 400)
    }
    if (body.chunks.length > MAX_CHUNKS_PER_BATCH) {
      return jsonResponse({ error: `batch too large (max ${MAX_CHUNKS_PER_BATCH})` }, 400)
    }

    // First batch creates the document row; later batches reuse its id.
    let documentId = body.documentId
    if (!documentId) {
      const { data, error } = await db
        .from('documents')
        .insert({
          notebook_id: body.notebookId,
          name: body.name,
          content_hash: body.contentHash,
          page_count: body.pageCount,
          is_rtl: body.isRtl,
        })
        .select('id')
        .single()

      // 23505 = unique_violation on (notebook_id, content_hash)
      if (error?.code === '23505') {
        return jsonResponse({ error: 'This document is already in the notebook.' }, 409)
      }
      if (error) throw error
      documentId = data.id
    }

    const vectors = await embed(body.chunks.map((c) => c.content))

    const rows = body.chunks.map((c, i) => ({
      document_id: documentId,
      content: c.content,
      page: c.page,
      chunk_index: c.index,
      embedding: JSON.stringify(vectors[i]),
    }))

    const { error } = await db.from('chunks').insert(rows)
    if (error) throw error

    return jsonResponse({ documentId, inserted: rows.length })
  } catch (e) {
    return errorResponse(e)
  }
})

// Quota is deliberately *not* consumed here. Documents are a resource cap, not a
// rate limit: the client checks quotaFor('recto','documents') against its own row
// count before starting, and RLS prevents anything worse than an over-count.
// Consuming a daily counter would leak slots whenever a document is deleted.
