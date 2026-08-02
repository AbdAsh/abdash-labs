import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@labs/platform', () => ({
  SUPABASE_URL: 'http://localhost',
  supabase: { auth: { getSession } },
}))

// doc-core is exercised by its own unit tests; here it is stubbed so the batching
// and transport logic is what is under test.
vi.mock('@labs/doc-core', () => ({
  extractPages: vi.fn(async (file: File) => [{ page: 1, text: await file.text() }]),
  chunkPages: vi.fn((pages: { page: number; text: string }[]) =>
    // 40 chars per chunk, so a modest file crosses several 50-chunk batches.
    pages.flatMap((p) =>
      (p.text.match(/.{1,40}/g) ?? []).map((content, i) => ({ content, page: p.page, index: i })),
    ),
  ),
  contentHash: vi.fn(async () => 'hash-abc'),
  isRTL: vi.fn(() => false),
}))

import { ingestFile, DuplicateDocumentError } from './ingest'

interface RecordedCall {
  notebookId: string
  documentId?: string
  name: string
  contentHash: string
  isRtl: boolean
  pageCount: number
  chunks: { content: string; page: number; index: number }[]
  __headers: Record<string, string>
}

describe('ingestFile', () => {
  const calls: RecordedCall[] = []

  function stubIngest(reply: (body: RecordedCall) => Partial<Response>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: RequestInit) => {
        const body = JSON.parse(opts.body as string) as RecordedCall
        calls.push({ ...body, __headers: opts.headers as Record<string, string> })
        return reply(body) as Response
      }),
    )
  }

  const ok = (body: RecordedCall) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        documentId: body.documentId ?? 'doc-1',
        inserted: body.chunks.length,
      }),
    }) as Partial<Response>

  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-abc' } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('threads one documentId across batches of 50 and caps progress', async () => {
    stubIngest(ok)
    // 40 chars per chunk × 50 chunks = 2000 chars per batch; 3 batches' worth.
    const file = new File(['x'.repeat(5000)], 'big.txt', { type: 'text/plain' })

    const progress: [number, number][] = []
    const result = await ingestFile(file, 'nb-1', (done, total) => progress.push([done, total]))

    expect(calls.length).toBeGreaterThan(1) // multiple batches actually occurred
    for (const c of calls) expect(c.chunks.length).toBeLessThanOrEqual(50)
    expect(calls[0]!.documentId).toBeUndefined() // first batch creates the document
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.documentId).toBe('doc-1')

    expect(result).toEqual({ documentId: 'doc-1', name: 'big.txt', isRtl: false })

    const total = progress[0]![1]
    for (const [done, t] of progress) {
      expect(t).toBe(total)
      expect(done).toBeLessThanOrEqual(total) // never overshoots
    }
    expect(progress.at(-1)![0]).toBe(total) // ends exactly at total
  })

  it('authenticates with the session JWT, not a shared app secret', async () => {
    stubIngest(ok)
    await ingestFile(new File(['short'], 'a.txt'), 'nb-1', () => {})
    expect(calls[0]!.__headers.Authorization).toBe('Bearer jwt-abc')
    expect(calls[0]!.__headers['x-app-secret']).toBeUndefined()
  })

  it('sends the content hash, page count and direction on every batch', async () => {
    stubIngest(ok)
    await ingestFile(new File(['x'.repeat(5000)], 'a.txt'), 'nb-7', () => {})
    for (const c of calls) {
      expect(c.notebookId).toBe('nb-7')
      expect(c.contentHash).toBe('hash-abc')
      expect(c.pageCount).toBe(1)
      expect(c.isRtl).toBe(false)
    }
  })

  it('raises DuplicateDocumentError on 409', async () => {
    stubIngest(() => ({ ok: false, status: 409, text: async () => 'already in the notebook' }))
    await expect(ingestFile(new File(['hi'], 'a.txt'), 'nb-1', () => {})).rejects.toBeInstanceOf(
      DuplicateDocumentError,
    )
  })

  it('reports other failures with their status and body', async () => {
    stubIngest(() => ({ ok: false, status: 500, text: async () => 'boom' }))
    await expect(ingestFile(new File(['hi'], 'a.txt'), 'nb-1', () => {})).rejects.toThrow(
      /500.*boom/,
    )
  })

  it('explains an empty extraction instead of posting nothing', async () => {
    stubIngest(ok)
    await expect(ingestFile(new File([''], 'blank.txt'), 'nb-1', () => {})).rejects.toThrow(
      /no readable text/i,
    )
    expect(calls).toHaveLength(0)
  })
})
