import { describe, it, expect, beforeAll } from 'vitest'
import { anonUser } from './helpers'

/**
 * GraphRead's table is deliberately the odd one out: readable by everyone,
 * writable only by its owner. A permalink has to open for a stranger, so a
 * public `select` policy is the feature — but that makes the write-side tests
 * matter more, not less, because read isolation is not there to catch a
 * mistake in them.
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

  it('lets a stranger open the permalink by slug', async () => {
    const { data, error } = await b.db
      .schema('graphread')
      .from('graphs')
      .select('slug, doc_name, nodes, edges, corrections')
      .eq('slug', slug)
      .single()
    expect(error).toBeNull()
    expect(data?.slug).toBe(slug)
  })

  it('returns corrections with the graph so a shared link reopens identically', async () => {
    const corrections = [{ kind: 'merge', ids: ['person:sarah-chen', 'person:chen'] }]
    await a.db.schema('graphread').from('graphs').update({ corrections }).eq('id', graphId)

    const { data } = await b.db
      .schema('graphread')
      .from('graphs')
      .select('corrections')
      .eq('slug', slug)
      .single()
    expect(data?.corrections).toEqual(corrections)
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
