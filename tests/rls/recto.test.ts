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
    const zeros = `[${Array.from({ length: 1536 }, () => 0).join(',')}]`
    const { data } = await b.db
      .schema('recto')
      .rpc('match_chunks', { query_embedding: zeros, match_count: 8, nb: notebookId })
    expect(data ?? []).toEqual([])
  })
})
