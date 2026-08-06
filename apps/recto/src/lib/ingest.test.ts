import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSession, deleteDocument } = vi.hoisted(() => ({
  getSession: vi.fn(),
  deleteDocument: vi.fn(),
}))

vi.mock('@labs/platform', () => ({
  SUPABASE_URL: 'http://localhost',
  supabase: { auth: { getSession } },
}))

// The rollback path is the point of this mock: a failed upload has to take its
// half-built document row with it.
vi.mock('./documents', () => ({ deleteDocument }))

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

import { ingestFile, DuplicateDocumentError, type IngestProgress } from './ingest'

interface RecordedCall {
  notebookId: string
  documentId?: string
  name: string
  contentHash: string
  isRtl: boolean
  pageCount: number
  chunks: { content: string; page: number; index: number }[]
  final: boolean
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
    // The real deleteDocument is async; a bare vi.fn() returning undefined
    // would make the rollback path pass for the wrong reason.
    deleteDocument.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('threads one documentId across batches of 50 and caps progress', async () => {
    stubIngest(ok)
    // 40 chars per chunk × 50 chunks = 2000 chars per batch; 3 batches' worth.
    const file = new File(['x'.repeat(5000)], 'big.txt', { type: 'text/plain' })

    const progress: IngestProgress[] = []
    const result = await ingestFile(file, 'nb-1', (p) => progress.push(p))

    expect(calls.length).toBeGreaterThan(1) // multiple batches actually occurred
    for (const c of calls) expect(c.chunks.length).toBeLessThanOrEqual(50)
    expect(calls[0]!.documentId).toBeUndefined() // first batch creates the document
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.documentId).toBe('doc-1')

    expect(result).toEqual({ documentId: 'doc-1', name: 'big.txt', isRtl: false })

    // Extraction is reported before any request goes out, so the slowest part
    // of an upload is not spent showing "0 of 0".
    expect(progress[0]).toEqual({ phase: 'reading', done: 0, total: 0 })
    expect(calls).toHaveLength(progress.filter((p) => p.done > 0).length)

    const indexing = progress.filter((p) => p.phase === 'indexing')
    const total = indexing[0]!.total
    expect(total).toBeGreaterThan(50)
    expect(indexing[0]!.done).toBe(0) // the real total is known before batch one
    for (const p of indexing) {
      expect(p.total).toBe(total)
      expect(p.done).toBeLessThanOrEqual(total) // never overshoots
    }
    expect(indexing.at(-1)!.done).toBe(total) // ends exactly at total
  })

  it('marks only the last batch final, so a stalled upload cannot look complete', async () => {
    stubIngest(ok)
    await ingestFile(new File(['x'.repeat(5000)], 'big.txt'), 'nb-1', () => {})
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls.slice(0, -1)) expect(c.final).toBe(false)
    expect(calls.at(-1)!.final).toBe(true)
  })

  it('marks a single-batch document final on its only request', async () => {
    stubIngest(ok)
    await ingestFile(new File(['short'], 'a.txt'), 'nb-1', () => {})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.final).toBe(true)
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

  it('prefers the function’s own sentence over the raw body', async () => {
    stubIngest(() => ({
      ok: false,
      status: 503,
      text: async () => '{"error":"The embedding service is busy right now.","retryable":true}',
    }))
    await expect(ingestFile(new File(['hi'], 'a.txt'), 'nb-1', () => {})).rejects.toThrow(
      'The embedding service is busy right now.',
    )
  })

  it('explains an empty extraction instead of posting nothing', async () => {
    stubIngest(ok)
    await expect(ingestFile(new File([''], 'blank.txt'), 'nb-1', () => {})).rejects.toThrow(
      /no readable text/i,
    )
    expect(calls).toHaveLength(0)
  })

  describe('when a batch fails part way through', () => {
    /** Succeeds until `failAt`, then 500s — the shape of an embedding timeout or
     *  a rate limit landing on batch two of six. */
    function stubFailingAt(failAt: number) {
      let n = 0
      stubIngest((body) =>
        ++n < failAt ? ok(body) : { ok: false, status: 500, text: async () => 'upstream died' },
      )
    }

    it('removes the half-built document so the retry is not blocked by its own hash', async () => {
      stubFailingAt(2)
      await expect(
        ingestFile(new File(['x'.repeat(5000)], 'big.txt'), 'nb-1', () => {}),
      ).rejects.toThrow(/upstream died/)
      // Without this the row survives as a document that looks whole and
      // answers from its first fifty passages, and re-uploading is refused by
      // the unique (notebook_id, content_hash) constraint.
      expect(deleteDocument).toHaveBeenCalledWith('doc-1')
    })

    it('never marked the document final, so nothing was promoted to ready', async () => {
      stubFailingAt(2)
      await expect(
        ingestFile(new File(['x'.repeat(5000)], 'big.txt'), 'nb-1', () => {}),
      ).rejects.toThrow()
      for (const c of calls) expect(c.final).toBe(false)
    })

    it('has nothing to roll back when the very first batch fails', async () => {
      stubFailingAt(1)
      await expect(ingestFile(new File(['hi'], 'a.txt'), 'nb-1', () => {})).rejects.toThrow()
      expect(deleteDocument).not.toHaveBeenCalled()
    })

    it('reports the original failure even when the rollback also fails', async () => {
      stubFailingAt(2)
      deleteDocument.mockRejectedValue(new Error('offline'))
      await expect(
        ingestFile(new File(['x'.repeat(5000)], 'big.txt'), 'nb-1', () => {}),
      ).rejects.toThrow(/upstream died/)
    })
  })
})
