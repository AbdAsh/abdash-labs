import { supabase } from '@labs/platform'

// v1's `documents` and `delete-document` Edge Functions are deliberately not
// ported: with RLS doing the filtering there was no server logic left in either.
// These are straight PostgREST reads under the caller's own policies.

const db = () => supabase.schema('recto')

/** `indexing` until the last batch of chunks lands. Retrieval ignores anything
 *  that is not `ready`, so a document stuck here answers nothing rather than
 *  answering from the fraction of itself that made it in. */
export type DocumentStatus = 'indexing' | 'ready'

export interface DocumentRow {
  id: string
  name: string
  pageCount: number | null
  isRtl: boolean
  status: DocumentStatus
  createdAt: string
}

interface RawDocument {
  id: string
  name: string
  page_count: number | null
  is_rtl: boolean
  status: string
  created_at: string
}

interface PostgrestFailure {
  message?: string
}

/** PostgREST returns a plain object rather than an Error; throwing it verbatim
 *  reaches the interface as "[object Object]". */
function dbError(what: string, error: PostgrestFailure): Error {
  return new Error(`Could not ${what}: ${error.message ?? 'the database refused the request.'}`)
}

export async function listDocuments(notebookId: string): Promise<DocumentRow[]> {
  const { data, error } = await db()
    .from('documents')
    .select('id, name, page_count, is_rtl, status, created_at')
    .eq('notebook_id', notebookId)
    .order('created_at', { ascending: true })
  if (error) throw dbError('load this notebook’s documents', error)
  return ((data ?? []) as RawDocument[]).map((d) => ({
    id: d.id,
    name: d.name,
    pageCount: d.page_count,
    isRtl: d.is_rtl,
    status: d.status === 'ready' ? 'ready' : 'indexing',
    createdAt: d.created_at,
  }))
}

/** Cascades to the document's chunks via FK, so citations for every other
 *  document in the notebook keep working. */
export async function deleteDocument(id: string): Promise<void> {
  const { error } = await db().from('documents').delete().eq('id', id)
  if (error) throw dbError('remove the document', error)
}

/** A notebook reads right-to-left when any document in it does — which is what
 *  mirrors the spread. Turkish documents stay left-to-right; see doc-core/rtl. */
export function notebookIsRtl(docs: DocumentRow[]): boolean {
  return docs.some((d) => d.isRtl)
}

/** The documents a question can actually be answered from. An unfinished one is
 *  invisible to `match_chunks`, so counting it would promise an answer the
 *  notebook cannot give. */
export function readyDocuments(docs: DocumentRow[]): DocumentRow[] {
  return docs.filter((d) => d.status === 'ready')
}
