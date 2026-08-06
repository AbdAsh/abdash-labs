import { supabase, quotaFor, QuotaExceededError } from '@labs/platform'

const db = () => supabase.schema('recto')

export interface Notebook {
  id: string
  title: string
  createdAt: string
  documentCount: number
}

interface NotebookRow {
  id: string
  title: string
  created_at: string
  documents?: { count: number }[]
}

interface PostgrestFailure {
  message?: string
}

/** PostgREST hands back a plain `{ message, details, hint, code }` object, not an
 *  Error — so `throw error` surfaces in the interface as the literal string
 *  "[object Object]". Every read and write in this app normalises here instead,
 *  which is the same boundary Critiq draws. */
function dbError(what: string, error: PostgrestFailure): Error {
  return new Error(`Could not ${what}: ${error.message ?? 'the database refused the request.'}`)
}

export async function listNotebooks(): Promise<Notebook[]> {
  const { data, error } = await db()
    .from('notebooks')
    .select('id, title, created_at, documents(count)')
    .order('created_at', { ascending: false })
  if (error) throw dbError('load your notebooks', error)
  return ((data ?? []) as NotebookRow[]).map((n) => ({
    id: n.id,
    title: n.title,
    createdAt: n.created_at,
    documentCount: n.documents?.[0]?.count ?? 0,
  }))
}

/** Resource cap, checked against the live row count so deleting frees a slot.
 *  A counter would leak slots on delete, which is why this is not a rate limit. */
export async function createNotebook(title: string): Promise<Notebook> {
  const limit = await quotaFor('recto', 'notebooks')
  const { count } = await db().from('notebooks').select('id', { count: 'exact', head: true })
  if ((count ?? 0) >= limit) throw new QuotaExceededError('recto', 'notebooks')

  const { data, error } = await db()
    .from('notebooks')
    .insert({ title })
    .select('id, title, created_at')
    .single()
  if (error) throw dbError('create the notebook', error)
  return { id: data.id, title: data.title, createdAt: data.created_at, documentCount: 0 }
}

export async function renameNotebook(id: string, title: string): Promise<void> {
  const { error } = await db().from('notebooks').update({ title }).eq('id', id)
  if (error) throw dbError('rename the notebook', error)
}

/** Cascades to documents, chunks, conversations and messages via FK. */
export async function deleteNotebook(id: string): Promise<void> {
  const { error } = await db().from('notebooks').delete().eq('id', id)
  if (error) throw dbError('delete the notebook', error)
}
