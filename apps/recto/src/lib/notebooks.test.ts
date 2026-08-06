import { describe, it, expect, vi, beforeEach } from 'vitest'

const { from, quotaFor } = vi.hoisted(() => ({ from: vi.fn(), quotaFor: vi.fn() }))

vi.mock('@labs/platform', () => ({
  supabase: { schema: () => ({ from }) },
  quotaFor,
  QuotaExceededError: class QuotaExceededError extends Error {
    constructor(app: string, key: string) {
      super(`Daily limit reached for ${app}:${key}.`)
      this.name = 'QuotaExceededError'
    }
  },
}))

import { listNotebooks, createNotebook, renameNotebook, deleteNotebook } from './notebooks'

/** Minimal PostgREST-shaped builder: every method returns the builder, and the
 *  builder itself resolves to `result`. */
function builder(result: unknown) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'single']) {
    b[m] = vi.fn(() => b)
  }
  // Deliberately thenable: the real PostgREST builder is awaited directly after
  // any chain of methods, and the mock has to behave the same way.
  // oxlint-disable-next-line no-thenable
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return b
}

beforeEach(() => vi.clearAllMocks())

describe('listNotebooks', () => {
  it('maps the documents(count) aggregate into documentCount', async () => {
    from.mockReturnValue(
      builder({
        data: [
          { id: 'n1', title: 'One', created_at: '2026-08-01T00:00:00Z', documents: [{ count: 2 }] },
          { id: 'n2', title: 'Two', created_at: '2026-07-01T00:00:00Z', documents: [] },
        ],
        error: null,
      }),
    )
    await expect(listNotebooks()).resolves.toEqual([
      { id: 'n1', title: 'One', createdAt: '2026-08-01T00:00:00Z', documentCount: 2 },
      { id: 'n2', title: 'Two', createdAt: '2026-07-01T00:00:00Z', documentCount: 0 },
    ])
  })

  // PostgREST returns a plain `{ message, details, hint, code }` object, never
  // an Error. Mocking it as `new Error(...)` hid the fact that `throw error`
  // reached the interface as the literal string "[object Object]".
  it('turns the raw PostgREST failure into a readable Error', async () => {
    from.mockReturnValue(
      builder({
        data: null,
        error: { message: 'schema must be one of the following: public', details: '', hint: null, code: 'PGRST106' },
      }),
    )
    await expect(listNotebooks()).rejects.toBeInstanceOf(Error)
    await expect(listNotebooks()).rejects.toThrow(/schema must be one of the following/)
    await expect(listNotebooks()).rejects.not.toThrow(/\[object Object\]/)
  })
})

describe('createNotebook', () => {
  it('refuses when the caller is already at their cap', async () => {
    quotaFor.mockResolvedValue(1)
    from.mockReturnValue(builder({ count: 1, error: null }))
    await expect(createNotebook('x')).rejects.toThrow(/recto:notebooks/)
    // The insert must never be attempted.
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('creates the notebook when under the cap', async () => {
    quotaFor.mockResolvedValue(3)
    from
      .mockReturnValueOnce(builder({ count: 1, error: null }))
      .mockReturnValueOnce(
        builder({
          data: { id: 'n9', title: 'Fresh', created_at: '2026-08-01T12:00:00Z' },
          error: null,
        }),
      )
    await expect(createNotebook('Fresh')).resolves.toEqual({
      id: 'n9',
      title: 'Fresh',
      createdAt: '2026-08-01T12:00:00Z',
      documentCount: 0,
    })
  })

  it('fails closed when the quota lookup returns zero', async () => {
    // quotaFor returns 0 for an unconfigured key or a failed rpc.
    quotaFor.mockResolvedValue(0)
    from.mockReturnValue(builder({ count: 0, error: null }))
    await expect(createNotebook('x')).rejects.toThrow(/recto:notebooks/)
  })
})

describe('renameNotebook / deleteNotebook', () => {
  it('surfaces a rename failure as a sentence, not as [object Object]', async () => {
    from.mockReturnValue(builder({ error: { message: 'new row violates row-level security' } }))
    await expect(renameNotebook('n1', 't')).rejects.toThrow(/row-level security/)
    await expect(renameNotebook('n1', 't')).rejects.not.toThrow(/\[object Object\]/)
  })

  it('resolves on a successful delete', async () => {
    from.mockReturnValue(builder({ error: null }))
    await expect(deleteNotebook('n1')).resolves.toBeUndefined()
  })

  it('surfaces a failed delete', async () => {
    from.mockReturnValue(builder({ error: { message: 'deadlock detected' } }))
    await expect(deleteNotebook('n1')).rejects.toThrow(/deadlock detected/)
  })
})
