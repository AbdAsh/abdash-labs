import { describe, it, expect } from 'vitest'
import { anonUser } from './helpers'

// Every call chains .schema('platform') explicitly — `helpers.ts` is shared with
// every app's RLS suite and must not pin a default schema.
describe('platform RLS', () => {
  it('creates a profile row for a new anonymous user', async () => {
    const { db, userId } = await anonUser()
    const { data } = await db.schema('platform')
      .from('profiles').select('id').eq('id', userId).single()
    expect(data?.id).toBe(userId)
  })

  it('hides one user profile from another', async () => {
    const a = await anonUser()
    const b = await anonUser()
    const { data } = await b.db.schema('platform')
      .from('profiles').select('id').eq('id', a.userId)
    expect(data).toEqual([])
  })

  it('grants the anon tier by default and enforces it', async () => {
    const { db } = await anonUser()
    const { data: limit } = await db.schema('platform')
      .rpc('quota_for', { p_app: 'recto', p_key: 'notebooks' })
    expect(limit).toBe(1)
  })

  it('returns false once a daily rate limit is exceeded', async () => {
    const { db } = await anonUser()
    // critiq anon reviews = 1
    const first = await db.schema('platform')
      .rpc('consume_quota', { p_app: 'critiq', p_key: 'reviews', p_amount: 1 })
    const second = await db.schema('platform')
      .rpc('consume_quota', { p_app: 'critiq', p_key: 'reviews', p_amount: 1 })
    expect(first.data).toBe(true)
    expect(second.data).toBe(false)
  })

  it('fails closed for an unconfigured quota key', async () => {
    const { db } = await anonUser()
    const { data } = await db.schema('platform')
      .rpc('consume_quota', { p_app: 'nope', p_key: 'nope', p_amount: 1 })
    expect(data).toBe(false)
  })
})
