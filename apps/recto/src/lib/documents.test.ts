import { describe, it, expect, vi, beforeEach } from 'vitest'

const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@labs/platform', () => ({ supabase: { schema: () => ({ from }) } }))

import {
  listDocuments,
  deleteDocument,
  notebookIsRtl,
  readyDocuments,
  type DocumentRow,
} from './documents'

function builder(result: unknown) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'single']) {
    b[m] = vi.fn(() => b)
  }
  // oxlint-disable-next-line no-thenable
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return b
}

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'd1',
    name: 'a.pdf',
    pageCount: 4,
    isRtl: false,
    status: 'ready',
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('listDocuments', () => {
  it('maps the snake_case row, status included', async () => {
    from.mockReturnValue(
      builder({
        data: [
          {
            id: 'd1',
            name: 'a.pdf',
            page_count: 12,
            is_rtl: true,
            status: 'ready',
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
        error: null,
      }),
    )
    await expect(listDocuments('nb-1')).resolves.toEqual([
      {
        id: 'd1',
        name: 'a.pdf',
        pageCount: 12,
        isRtl: true,
        status: 'ready',
        createdAt: '2026-08-01T00:00:00Z',
      },
    ])
  })

  // Anything that is not exactly 'ready' must not be treated as searchable —
  // a new status added later should fail closed, not silently join retrieval.
  it.each([['indexing'], ['queued'], [''], ['READY']])(
    'treats the status %j as unfinished',
    async (status) => {
      from.mockReturnValue(
        builder({
          data: [
            {
              id: 'd1',
              name: 'a.pdf',
              page_count: null,
              is_rtl: false,
              status,
              created_at: '2026-08-01T00:00:00Z',
            },
          ],
          error: null,
        }),
      )
      const [row] = await listDocuments('nb-1')
      expect(row?.status).toBe('indexing')
    },
  )

  it('turns a raw PostgREST failure into a readable sentence', async () => {
    const postgrestError = { message: 'relation does not exist', details: '', hint: null, code: '42P01' }
    from.mockReturnValue(builder({ data: null, error: postgrestError }))
    await expect(listDocuments('nb-1')).rejects.toBeInstanceOf(Error)
    await expect(listDocuments('nb-1')).rejects.toThrow(/relation does not exist/)
  })

  it('reports a failed delete rather than resolving quietly', async () => {
    from.mockReturnValue(builder({ error: { message: 'permission denied' } }))
    await expect(deleteDocument('d1')).rejects.toThrow(/permission denied/)
  })
})

describe('notebookIsRtl', () => {
  it('mirrors the spread when any document reads right to left', () => {
    expect(notebookIsRtl([doc(), doc({ id: 'd2', isRtl: true })])).toBe(true)
  })

  it('leaves an all-left-to-right notebook alone', () => {
    expect(notebookIsRtl([doc(), doc({ id: 'd2' })])).toBe(false)
  })

  it('leaves an empty notebook alone', () => {
    expect(notebookIsRtl([])).toBe(false)
  })
})

describe('readyDocuments', () => {
  // match_chunks excludes unfinished documents, so counting them would promise
  // an answer the notebook cannot give.
  it('keeps only what retrieval can actually see', () => {
    const docs = [doc(), doc({ id: 'd2', status: 'indexing' }), doc({ id: 'd3' })]
    expect(readyDocuments(docs).map((d) => d.id)).toEqual(['d1', 'd3'])
  })

  it('is empty when every document stalled', () => {
    expect(readyDocuments([doc({ status: 'indexing' })])).toEqual([])
  })
})
