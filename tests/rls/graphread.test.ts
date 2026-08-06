import { describe, it, expect, beforeAll } from 'vitest'
import { anonUser } from './helpers'

/**
 * GraphRead's table is the odd one out: a permalink has to open for a stranger,
 * but the table itself must not. There is no public `select` policy, because
 * RLS cannot see that a client filtered by slug — `using (true)` would grant
 * the whole table and let anyone list every document every user has graphed,
 * with owner ids attached.
 *
 * So reads go through the SECURITY DEFINER accessor `graphread.graph_by_slug`,
 * which puts the filter inside the security boundary. These tests are as much
 * about what the accessor does *not* return as what it does.
 */
describe('graphread RLS', () => {
  let a: Awaited<ReturnType<typeof anonUser>>
  let b: Awaited<ReturnType<typeof anonUser>>
  let slug: string
  let graphId: string

  const graph = (over: Record<string, unknown> = {}) => ({
    slug: `test-${crypto.randomUUID()}`,
    doc_name: 'A private report.pdf',
    nodes: [{ id: 'person:sarah-chen', name: 'Dr. Sarah Chen', type: 'person' }],
    edges: [],
    stats: { chunks: 1, droppedRelations: 0 },
    chunk_pages: { c0: 1 },
    ...over,
  })

  beforeAll(async () => {
    a = await anonUser()
    b = await anonUser()
    const row = graph()
    slug = row.slug
    const { data, error } = await a.db
      .schema('graphread')
      .from('graphs')
      .insert(row)
      .select('id')
      .single()
    if (error) throw error
    graphId = data.id
  })

  it('sets owner_id from the JWT without the client sending it', async () => {
    const { data } = await a.db
      .schema('graphread')
      .from('graphs')
      .select('owner_id')
      .eq('id', graphId)
      .single()
    expect(data?.owner_id).toBe(a.userId)
  })

  it('lets a stranger open the permalink through the accessor', async () => {
    const { data, error } = await b.db
      .schema('graphread')
      .rpc('graph_by_slug', { p_slug: slug })
    expect(error).toBeNull()
    const row = (data as Record<string, unknown>[])[0]
    expect(row?.slug).toBe(slug)
    expect(row?.doc_name).toBe('A private report.pdf')
  })

  it('never tells the accessor caller who owns the graph', async () => {
    const { data } = await b.db.schema('graphread').rpc('graph_by_slug', { p_slug: slug })
    const row = (data as Record<string, unknown>[])[0]!
    expect(Object.keys(row)).not.toContain('owner_id')
    // The one thing said about ownership is about *you*, and only ever "no".
    expect(row.is_owner).toBe(false)
  })

  it('tells the owner that the row is theirs to write', async () => {
    const { data } = await a.db.schema('graphread').rpc('graph_by_slug', { p_slug: slug })
    expect((data as Record<string, unknown>[])[0]!.is_owner).toBe(true)
  })

  it('returns nothing for a slug that names no graph', async () => {
    const { data, error } = await b.db
      .schema('graphread')
      .rpc('graph_by_slug', { p_slug: 'no-such-graph-9999' })
    expect(error).toBeNull()
    expect(data ?? []).toEqual([])
  })

  it('refuses to let a stranger read the table directly', async () => {
    // The whole reason the accessor exists. Without a select policy this is
    // empty for user b, so nobody can enumerate what anyone else has graphed.
    const { data } = await b.db
      .schema('graphread')
      .from('graphs')
      .select('slug, doc_name, owner_id')
      .eq('slug', slug)
    expect(data ?? []).toEqual([])
  })

  it('refuses to let a stranger list the table at all', async () => {
    const { data } = await b.db.schema('graphread').from('graphs').select('id').limit(100)
    expect((data ?? []).some((r: { id: string }) => r.id === graphId)).toBe(false)
  })

  it('returns corrections with the graph so a shared link reopens identically', async () => {
    const corrections = [{ kind: 'merge', ids: ['person:sarah-chen', 'person:chen'] }]
    await a.db.schema('graphread').from('graphs').update({ corrections }).eq('id', graphId)

    const { data } = await b.db.schema('graphread').rpc('graph_by_slug', { p_slug: slug })
    expect((data as Record<string, unknown>[])[0]!.corrections).toEqual(corrections)
  })

  it('carries the chunk-to-page map so a stranger sees page numbers, not chunk ids', async () => {
    const { data } = await b.db.schema('graphread').rpc('graph_by_slug', { p_slug: slug })
    expect((data as Record<string, unknown>[])[0]!.chunk_pages).toEqual({ c0: 1 })
  })

  it('lets the owner save corrections by slug', async () => {
    // saveCorrections updates by slug under the owner policy rather than by id.
    const corrections = [{ kind: 'split', id: 'person:sarah-chen', alias: 'Chen' }]
    const { error } = await a.db
      .schema('graphread')
      .from('graphs')
      .update({ corrections })
      .eq('slug', slug)
    expect(error).toBeNull()

    const { data } = await a.db.schema('graphread').rpc('graph_by_slug', { p_slug: slug })
    expect((data as Record<string, unknown>[])[0]!.corrections).toEqual(corrections)
  })

  it('silently changes nothing when a stranger saves corrections by slug', async () => {
    // Zero rows match under the owner policy, and PostgREST reports no error —
    // which is why the client checks is_owner before ever calling this.
    const { data, error } = await b.db
      .schema('graphread')
      .from('graphs')
      .update({ corrections: [{ kind: 'merge', ids: ['a', 'b'] }] })
      .eq('slug', slug)
      .select()
    expect(error).toBeNull()
    expect(data ?? []).toEqual([])

    const { data: after } = await a.db.schema('graphread').rpc('graph_by_slug', { p_slug: slug })
    expect((after as Record<string, unknown>[])[0]!.corrections).toEqual([
      { kind: 'split', id: 'person:sarah-chen', alias: 'Chen' },
    ])
  })

  it('refuses a cross-user update', async () => {
    const { data } = await b.db
      .schema('graphread')
      .from('graphs')
      .update({ doc_name: 'hijacked' })
      .eq('id', graphId)
      .select()
    expect(data ?? []).toEqual([])

    const { data: still } = await a.db
      .schema('graphread')
      .from('graphs')
      .select('doc_name')
      .eq('id', graphId)
      .single()
    expect(still?.doc_name).toBe('A private report.pdf')
  })

  it('refuses a cross-user delete', async () => {
    await b.db.schema('graphread').from('graphs').delete().eq('id', graphId)
    const { data } = await a.db
      .schema('graphread')
      .from('graphs')
      .select('id')
      .eq('id', graphId)
      .maybeSingle()
    expect(data?.id).toBe(graphId)
  })

  it('refuses an insert that claims another user as owner', async () => {
    const { error } = await b.db
      .schema('graphread')
      .from('graphs')
      .insert(graph({ owner_id: a.userId }))
      .select()
    // `with check (owner_id = auth.uid())` must reject this outright.
    expect(error).not.toBeNull()
  })

  it('rejects a duplicate slug so a permalink always names one graph', async () => {
    const { error } = await b.db
      .schema('graphread')
      .from('graphs')
      .insert(graph({ slug }))
      .select()
    expect(error).not.toBeNull()
  })

  it('seeds both graphread quota keys', async () => {
    const { data: extractions } = await a.db
      .schema('platform')
      .rpc('quota_for', { p_app: 'graphread', p_key: 'extractions' })
    const { data: chunks } = await a.db
      .schema('platform')
      .rpc('quota_for', { p_app: 'graphread', p_key: 'chunks' })
    expect(extractions).toBe(1)
    expect(chunks).toBe(80)
  })

  it('stops charging chunks once the anonymous ceiling is reached', async () => {
    const { db } = await anonUser()
    const { data: over } = await db
      .schema('platform')
      .rpc('consume_quota', { p_app: 'graphread', p_key: 'chunks', p_amount: 81 })
    expect(over).toBe(false)
  })
})
