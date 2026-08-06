import { describe, it, expect, vi, beforeEach } from 'vitest'

const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@labs/platform', () => ({ supabase: { schema: () => ({ from }) } }))

import { loadConversation, listConversations, deleteConversation } from './conversations'

/** Minimal PostgREST-shaped builder: every method returns the builder, and the
 *  builder itself resolves to `result`. */
function builder(result: unknown) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'single']) {
    b[m] = vi.fn(() => b)
  }
  // oxlint-disable-next-line no-thenable
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return b
}

/** What PostgREST actually returns on failure: a plain object, NOT an Error.
 *  Throwing it verbatim is what puts "[object Object]" on the screen. */
const POSTGREST_ERROR = {
  message: 'permission denied for table messages',
  details: '',
  hint: null,
  code: '42501',
}

const CITATION = { n: 1, page: 3, document: 'a.pdf', content: 'x', similarity: 0.8 }

beforeEach(() => vi.clearAllMocks())

describe('loadConversation', () => {
  it('pairs flat messages into turns', async () => {
    from.mockReturnValue(
      builder({
        data: [
          { role: 'user', content: 'Q1', citations: null },
          { role: 'assistant', content: 'A1', citations: [CITATION] },
          { role: 'user', content: 'Q2', citations: null },
          { role: 'assistant', content: 'A2', citations: [] },
        ],
        error: null,
      }),
    )
    await expect(loadConversation('c1')).resolves.toEqual([
      { question: 'Q1', answer: 'A1', citations: [CITATION] },
      { question: 'Q2', answer: 'A2', citations: [] },
    ])
  })

  // A connection that dropped mid-stream leaves exactly this: a question whose
  // answer never got written. It has to survive the reload as an unanswered
  // turn, not disappear and not swallow the next turn's answer.
  it('keeps a question whose answer never arrived', async () => {
    from.mockReturnValue(
      builder({
        data: [
          { role: 'user', content: 'Q1', citations: null },
          { role: 'user', content: 'Q2', citations: null },
          { role: 'assistant', content: 'A2', citations: null },
        ],
        error: null,
      }),
    )
    await expect(loadConversation('c1')).resolves.toEqual([
      { question: 'Q1', answer: '', citations: [] },
      { question: 'Q2', answer: 'A2', citations: [] },
    ])
  })

  it('does not staple a second answer onto a turn that already has one', async () => {
    from.mockReturnValue(
      builder({
        data: [
          { role: 'user', content: 'Q1', citations: null },
          { role: 'assistant', content: 'A1', citations: null },
          { role: 'assistant', content: 'stray', citations: null },
        ],
        error: null,
      }),
    )
    await expect(loadConversation('c1')).resolves.toEqual([
      { question: 'Q1', answer: 'A1', citations: [] },
    ])
  })

  it('drops an assistant message with no question before it', async () => {
    from.mockReturnValue(
      builder({ data: [{ role: 'assistant', content: 'orphan', citations: null }], error: null }),
    )
    await expect(loadConversation('c1')).resolves.toEqual([])
  })

  it('treats a null citations column as an empty list', async () => {
    from.mockReturnValue(
      builder({
        data: [
          { role: 'user', content: 'Q', citations: null },
          { role: 'assistant', content: 'A', citations: null },
        ],
        error: null,
      }),
    )
    await expect(loadConversation('c1')).resolves.toEqual([
      { question: 'Q', answer: 'A', citations: [] },
    ])
  })

  it('returns nothing for a conversation with no messages', async () => {
    from.mockReturnValue(builder({ data: [], error: null }))
    await expect(loadConversation('c1')).resolves.toEqual([])
  })
})

describe('errors reaching the interface', () => {
  // PostgREST hands back a plain object. `throw error` renders as the string
  // "[object Object]", so every read normalises to a real Error first.
  it.each([
    ['loadConversation', () => loadConversation('c1')],
    ['listConversations', () => listConversations('nb-1')],
    ['deleteConversation', () => deleteConversation('c1')],
  ])('turns a raw PostgREST failure from %s into a readable sentence', async (_name, call) => {
    from.mockReturnValue(builder({ data: null, error: POSTGREST_ERROR }))
    await expect(call()).rejects.toBeInstanceOf(Error)
    await expect(call()).rejects.toThrow(/permission denied for table messages/)
    await expect(call()).rejects.not.toThrow(/\[object Object\]/)
  })

  it('still says something when the failure carries no message', async () => {
    from.mockReturnValue(builder({ data: null, error: { code: 'PGRST000' } }))
    await expect(listConversations('nb-1')).rejects.toThrow(/database refused/i)
  })
})
