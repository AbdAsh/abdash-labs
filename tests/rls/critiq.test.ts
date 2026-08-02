import { beforeAll, describe, expect, it } from 'vitest'
import { anonUser } from './helpers'

/**
 * Critiq reports are public by default — that is the point, the report markets
 * the tool — but "public" has to mean *this one report, by its slug*, not "the
 * table". These tests pin both halves: a stranger can open a permalink, and a
 * stranger cannot enumerate what anyone else has been auditing.
 */
describe('critiq RLS', () => {
  let a: Awaited<ReturnType<typeof anonUser>>
  let b: Awaited<ReturnType<typeof anonUser>>
  let slug: string
  let reportId: string

  const report = (over: Record<string, unknown> = {}) => ({
    slug: `test-${crypto.randomUUID()}`,
    url: 'https://example.com/a-private-audit',
    status: 'complete',
    grades: { overall: 'B', crawlability: 'A', metadata: 'C' },
    findings: [
      {
        id: 'title-length',
        source: 'check',
        dimension: 'metadata',
        severity: 'medium',
        title: 'The title is 90 characters and will be truncated',
        evidence: '90 characters',
        fix: 'Trim it.',
      },
    ],
    digest: { title: 'A page', wordCount: 1200 },
    ...over,
  })

  beforeAll(async () => {
    a = await anonUser()
    b = await anonUser()
    const row = report()
    slug = row.slug
    const { data, error } = await a.db
      .schema('critiq')
      .from('reports')
      .insert(row)
      .select('id')
      .single()
    if (error) throw error
    reportId = data.id
  })

  it('sets owner_id from the JWT without the client sending it', async () => {
    const { data } = await a.db
      .schema('critiq')
      .from('reports')
      .select('owner_id')
      .eq('id', reportId)
      .single()
    expect(data?.owner_id).toBe(a.userId)
  })

  it('lets a stranger open the permalink by slug', async () => {
    const { data, error } = await b.db
      .schema('critiq')
      .rpc('report_by_slug', { p_slug: slug })
    expect(error).toBeNull()
    expect(data?.[0]?.slug).toBe(slug)
    expect(data?.[0]?.grades?.overall).toBe('B')
    expect(data?.[0]?.findings?.[0]?.id).toBe('title-length')
  })

  it('does not leak who ran the report through the permalink', async () => {
    const { data } = await b.db.schema('critiq').rpc('report_by_slug', { p_slug: slug })
    expect(data?.[0]).not.toHaveProperty('owner_id')
  })

  it('returns nothing for a slug that does not exist', async () => {
    const { data } = await b.db
      .schema('critiq')
      .rpc('report_by_slug', { p_slug: 'no-such-slug-at-all' })
    expect(data ?? []).toEqual([])
  })

  it('refuses to let one user list the reports of another', async () => {
    // The whole reason permalinks go through a function: a table select must
    // never expose what someone else has been auditing.
    const { data } = await b.db
      .schema('critiq')
      .from('reports')
      .select('id, url, slug')
    const ids = (data ?? []).map((r: { id: string }) => r.id)
    expect(ids).not.toContain(reportId)
  })

  it('scopes a history listing to the caller', async () => {
    await b.db.schema('critiq').from('reports').insert(report({ url: 'https://b.test/own' }))

    const { data } = await b.db
      .schema('critiq')
      .from('reports')
      .select('url')
      .order('created_at', { ascending: false })
    const urls = (data ?? []).map((r: { url: string }) => r.url)
    expect(urls).toContain('https://b.test/own')
    expect(urls).not.toContain('https://example.com/a-private-audit')
  })

  it('refuses a cross-user update', async () => {
    const { data } = await b.db
      .schema('critiq')
      .from('reports')
      .update({ url: 'https://hijacked.test/' })
      .eq('id', reportId)
      .select()
    expect(data ?? []).toEqual([])

    const { data: still } = await a.db
      .schema('critiq')
      .from('reports')
      .select('url')
      .eq('id', reportId)
      .single()
    expect(still?.url).toBe('https://example.com/a-private-audit')
  })

  it('refuses a cross-user delete', async () => {
    await b.db.schema('critiq').from('reports').delete().eq('id', reportId)
    const { data } = await a.db
      .schema('critiq')
      .from('reports')
      .select('id')
      .eq('id', reportId)
      .maybeSingle()
    expect(data?.id).toBe(reportId)
  })

  it('lets the owner delete their own report by slug', async () => {
    const own = report({ url: 'https://example.com/disposable' })
    await a.db.schema('critiq').from('reports').insert(own)
    await a.db.schema('critiq').from('reports').delete().eq('slug', own.slug)

    const { data } = await a.db
      .schema('critiq')
      .rpc('report_by_slug', { p_slug: own.slug })
    expect(data ?? []).toEqual([])
  })

  it('refuses an insert that claims another user as owner', async () => {
    const { error } = await b.db
      .schema('critiq')
      .from('reports')
      .insert(report({ owner_id: a.userId }))
      .select()
    expect(error).not.toBeNull()
  })

  it('rejects a duplicate slug so a permalink always names one report', async () => {
    const { error } = await b.db
      .schema('critiq')
      .from('reports')
      .insert(report({ slug }))
      .select()
    expect(error).not.toBeNull()
  })

  it('seeds the critiq review quota at 1 a day for anonymous users', async () => {
    const { db } = await anonUser()
    const { data: limit } = await db
      .schema('platform')
      .rpc('quota_for', { p_app: 'critiq', p_key: 'reviews' })
    expect(limit).toBe(1)

    const first = await db
      .schema('platform')
      .rpc('consume_quota', { p_app: 'critiq', p_key: 'reviews', p_amount: 1 })
    const second = await db
      .schema('platform')
      .rpc('consume_quota', { p_app: 'critiq', p_key: 'reviews', p_amount: 1 })
    expect(first.data).toBe(true)
    expect(second.data).toBe(false)
  })
})
