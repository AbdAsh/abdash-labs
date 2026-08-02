import { describe, it, expect, vi } from 'vitest'

// vi.hoisted, not bare consts: vi.mock is hoisted above these declarations and its
// factory runs on first import of './quota', which would hit the temporal dead zone.
const { rpc, from, schema } = vi.hoisted(() => {
  const rpc = vi.fn()
  const from = vi.fn()
  const schema = vi.fn(() => ({ rpc, from }))
  return { rpc, from, schema }
})
vi.mock('./client', () => ({ supabase: { rpc, from, schema } }))

import { quotaFor, usedToday, QuotaExceededError } from './quota'

describe('quotaFor', () => {
  it('returns the numeric limit', async () => {
    rpc.mockResolvedValue({ data: 3, error: null })
    await expect(quotaFor('recto', 'notebooks')).resolves.toBe(3)
  })

  it('returns 0 for an unconfigured key so callers fail closed', async () => {
    rpc.mockResolvedValue({ data: -1, error: null })
    await expect(quotaFor('recto', 'nope')).resolves.toBe(0)
  })

  it('returns 0 when the rpc errors', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('boom') })
    await expect(quotaFor('recto', 'notebooks')).resolves.toBe(0)
  })

  it('calls the rpc in the platform schema, not public', async () => {
    schema.mockClear()
    rpc.mockResolvedValue({ data: 1, error: null })
    await quotaFor('recto', 'notebooks')
    expect(schema).toHaveBeenCalledWith('platform')
    expect(rpc).toHaveBeenLastCalledWith('quota_for', { p_app: 'recto', p_key: 'notebooks' })
  })
})

describe('usedToday', () => {
  it('reads usage_counters from the platform schema and defaults to 0', async () => {
    schema.mockClear()
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: null })),
    }
    from.mockReturnValue(chain)
    await expect(usedToday('recto', 'messages')).resolves.toBe(0)
    expect(schema).toHaveBeenCalledWith('platform')
    expect(from).toHaveBeenCalledWith('usage_counters')
  })

  it('returns the stored count when a row exists', async () => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: { count: 7 } })),
    }
    from.mockReturnValue(chain)
    await expect(usedToday('recto', 'messages')).resolves.toBe(7)
  })
})

describe('QuotaExceededError', () => {
  it('names the app and key in its message', () => {
    expect(new QuotaExceededError('recto', 'messages').message).toMatch(/recto.*messages/)
  })
})
