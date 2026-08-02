import { supabase } from '@labs/platform'

// v1's `documents` and `delete-document` Edge Functions are deliberately not
// ported: with RLS doing the filtering there was no server logic left in either.
// These are straight PostgREST reads under the caller's own policies.

const db = () => supabase.schema('recto')

export interface DocumentRow {
  id: string
  name: string
  pageCount: number | null
  isRtl: boolean
  createdAt: string
}

interface RawDocument {
  id: string
  name: string
  page_count: number | null
  is_rtl: boolean
  created_at: string
}

export async function listDocuments(notebookId: string): Promise<DocumentRow[]> {
  const { data, error } = await db()
    .from('documents')
    .select('id, name, page_count, is_rtl, created_at')
    .eq('notebook_id', notebookId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as RawDocument[]).map((d) => ({
    id: d.id,
    name: d.name,
    pageCount: d.page_count,
    isRtl: d.is_rtl,
    createdAt: d.created_at,
  }))
}

/** Cascades to the document's chunks via FK, so citations for every other
 *  document in the notebook keep working. */
export async function deleteDocument(id: string): Promise<void> {
  const { error } = await db().from('documents').delete().eq('id', id)
  if (error) throw error
}

/** A notebook reads right-to-left when any document in it does — which is what
 *  mirrors the spread. Turkish documents stay left-to-right; see doc-core/rtl. */
export function notebookIsRtl(docs: DocumentRow[]): boolean {
  return docs.some((d) => d.isRtl)
}
