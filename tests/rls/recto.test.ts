import { describe, it, expect, beforeAll } from 'vitest'
import { anonUser } from './helpers'

describe('recto RLS', () => {
  let a: Awaited<ReturnType<typeof anonUser>>
  let b: Awaited<ReturnType<typeof anonUser>>
  let notebookId: string

  beforeAll(async () => {
    a = await anonUser()
    b = await anonUser()
    const { data, error } = await a.db
      .schema('recto')
      .from('notebooks')
      .insert({ title: 'A private' })
      .select('id')
      .single()
    if (error) throw error
    notebookId = data.id
  })

  it('sets owner_id from the JWT without the client sending it', async () => {
    const { data } = await a.db
      .schema('recto')
      .from('notebooks')
      .select('owner_id')
      .eq('id', notebookId)
      .single()
    expect(data?.owner_id).toBe(a.userId)
  })

  it('hides one user notebook from another', async () => {
    const { data } = await b.db
      .schema('recto')
      .from('notebooks')
      .select('id')
      .eq('id', notebookId)
    expect(data).toEqual([])
  })

  it('refuses a cross-user update', async () => {
    const { data } = await b.db
      .schema('recto')
      .from('notebooks')
      .update({ title: 'hijacked' })
      .eq('id', notebookId)
      .select()
    expect(data ?? []).toEqual([])
    const { data: still } = await a.db
      .schema('recto')
      .from('notebooks')
      .select('title')
      .eq('id', notebookId)
      .single()
    expect(still?.title).toBe('A private')
  })

  it('refuses a cross-user delete — the v1 IDOR, now impossible', async () => {
    await b.db.schema('recto').from('notebooks').delete().eq('id', notebookId)
    const { data } = await a.db
      .schema('recto')
      .from('notebooks')
      .select('id')
      .eq('id', notebookId)
    expect(data).toHaveLength(1)
  })

  it('refuses inserting a row owned by someone else', async () => {
    const { error } = await b.db
      .schema('recto')
      .from('notebooks')
      .insert({ title: 'spoof', owner_id: a.userId })
    expect(error).toBeTruthy() // with check violation
  })

  it('rejects a duplicate content hash in the same notebook', async () => {
    const row = { notebook_id: notebookId, name: 'x.pdf', content_hash: 'deadbeef' }
    const first = await a.db.schema('recto').from('documents').insert(row)
    const second = await a.db.schema('recto').from('documents').insert(row)
    expect(first.error).toBeNull()
    expect(second.error).toBeTruthy()
  })

  it('returns no matches to a user who does not own the notebook', async () => {
    const { data } = await b.db
      .schema('recto')
      .rpc('match_chunks', { query_embedding: vector(0), match_count: 8, nb: notebookId })
    expect(data ?? []).toEqual([])
  })

  // ─── The ingest lifecycle, enforced by the schema rather than by the client ──

  it('starts a document as unfinished, so a stalled upload cannot look complete', async () => {
    const { data } = await a.db
      .schema('recto')
      .from('documents')
      .insert({ notebook_id: notebookId, name: 'fresh.pdf', content_hash: 'hash-fresh' })
      .select('status')
      .single()
    expect(data?.status).toBe('indexing')
  })

  it('refuses a status outside the lifecycle', async () => {
    const { error } = await a.db
      .schema('recto')
      .from('documents')
      .insert({
        notebook_id: notebookId,
        name: 'bogus.pdf',
        content_hash: 'hash-bogus',
        status: 'done',
      })
    expect(error).toBeTruthy() // check constraint violation
  })

  // A null embedding is invisible to every similarity search forever, so a bad
  // API response would otherwise buy a permanently half-searchable document.
  it('refuses a chunk with no embedding', async () => {
    const { data: doc } = await a.db
      .schema('recto')
      .from('documents')
      .insert({ notebook_id: notebookId, name: 'noembed.pdf', content_hash: 'hash-noembed' })
      .select('id')
      .single()

    const { error } = await a.db
      .schema('recto')
      .from('chunks')
      .insert({ document_id: doc!.id, content: 'orphan text', chunk_index: 0 })
    expect(error).toBeTruthy() // not-null violation
  })

  it('keeps an unfinished document out of retrieval, and lets it in once ready', async () => {
    const { data: doc } = await a.db
      .schema('recto')
      .from('documents')
      .insert({ notebook_id: notebookId, name: 'half.pdf', content_hash: 'hash-half' })
      .select('id')
      .single()

    const { error: chunkError } = await a.db
      .schema('recto')
      .from('chunks')
      .insert({
        document_id: doc!.id,
        content: 'a passage from a document that never finished',
        page: 1,
        chunk_index: 0,
        embedding: vector(0.1),
      })
    expect(chunkError).toBeNull()

    const search = () =>
      a.db
        .schema('recto')
        .rpc('match_chunks', { query_embedding: vector(0.1), match_count: 8, nb: notebookId })

    // Still 'indexing': the passage exists but must not be answerable, or the
    // notebook would quote a document that is only partly present.
    const before = await search()
    expect(before.data ?? []).toEqual([])

    await a.db.schema('recto').from('documents').update({ status: 'ready' }).eq('id', doc!.id)

    const after = await search()
    expect(after.data ?? []).toHaveLength(1)
    expect((after.data ?? [])[0].document_name).toBe('half.pdf')
  })
})

/** A 1536-dim halfvec literal, which is what `match_chunks` and the `chunks`
 *  column both expect. */
function vector(fill: number): string {
  return `[${Array.from({ length: 1536 }, () => fill).join(',')}]`
}
