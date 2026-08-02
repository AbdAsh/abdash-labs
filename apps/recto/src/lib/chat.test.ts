import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.hoisted, because vi.mock is lifted above every other statement in the file
// and its factory would otherwise close over an uninitialised binding.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('@labs/platform', () => ({
  supabase: { auth: { getSession } },
  SUPABASE_URL: 'http://localhost',
}))

import { consumeStream, streamChat, type Citation } from './chat'

const CITATION: Citation = {
  n: 1,
  page: 1,
  document: 'a.pdf',
  content: 'x',
  similarity: 0.9,
}

/** A ReadableStream that hands the reader exactly the pieces given, in order. */
function streamOf(parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(typeof p === 'string' ? enc.encode(p) : p)
      controller.close()
    },
  })
}

function collect(parts: (string | Uint8Array)[]) {
  const tokens: string[] = []
  const citations: Citation[][] = []
  return {
    tokens,
    citations,
    run: () =>
      consumeStream(
        streamOf(parts),
        (t) => tokens.push(t),
        (c) => citations.push(c),
      ),
  }
}

describe('consumeStream — the \\f protocol', () => {
  it('splits citations from answer tokens on the form feed', async () => {
    const c = collect([JSON.stringify([CITATION]) + '\f', 'Hello', ' world'])
    await c.run()
    expect(c.citations).toEqual([[CITATION]])
    expect(c.tokens.join('')).toBe('Hello world')
  })

  it('parses citations when the JSON is split across reads', async () => {
    const payload = JSON.stringify([CITATION])
    const mid = Math.floor(payload.length / 2)
    const c = collect([payload.slice(0, mid), payload.slice(mid) + '\f', 'Hello'])
    await c.run()
    expect(c.citations).toHaveLength(1)
    expect(c.citations[0]).toEqual([CITATION])
    expect(c.tokens.join('')).toBe('Hello')
  })

  it('emits answer text that shares a read with the form feed', async () => {
    const c = collect([JSON.stringify([CITATION]) + '\fHel', 'lo'])
    await c.run()
    expect(c.citations).toHaveLength(1)
    expect(c.tokens.join('')).toBe('Hello')
  })

  it('emits no tokens when the stream ends before the form feed', async () => {
    const c = collect(['[{"n":1'])
    await c.run()
    expect(c.citations).toEqual([])
    expect(c.tokens).toEqual([])
  })

  it('handles an empty citations array', async () => {
    const c = collect(['[]\fNothing was found in these documents.'])
    await c.run()
    expect(c.citations).toEqual([[]])
    expect(c.tokens.join('')).toBe('Nothing was found in these documents.')
  })

  it('rejoins a multi-byte character split across two reads', async () => {
    // Arabic answers are the point of this product, so a naive per-read
    // decode that drops a half-written UTF-8 sequence must be caught here.
    const bytes = new TextEncoder().encode('مرحبا')
    const c = collect([
      '[]\f',
      bytes.slice(0, 3), // cuts the second character in half
      bytes.slice(3),
    ])
    await c.run()
    expect(c.tokens.join('')).toBe('مرحبا')
  })

  it('surfaces malformed citation JSON rather than swallowing it', async () => {
    const c = collect(['{not json}\fanswer'])
    await expect(c.run()).rejects.toThrow()
  })
})

describe('streamChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-abc' } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(res: Partial<Response> & { body: ReadableStream<Uint8Array> | null }) {
    const fetchMock = vi.fn(async () => res as Response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sends the session JWT and returns the id from x-conversation-id', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-conversation-id': 'convo-9' }),
      body: streamOf([JSON.stringify([CITATION]) + '\f', 'Hi']),
    })

    const tokens: string[] = []
    const result = await streamChat('q', 'nb-1', undefined, (t) => tokens.push(t), () => {})

    expect(result).toEqual({ conversationId: 'convo-9' })
    expect(tokens.join('')).toBe('Hi')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost/functions/v1/recto-chat')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc')
    expect(JSON.parse(init.body as string)).toEqual({
      question: 'q',
      notebookId: 'nb-1',
      conversationId: undefined,
    })
  })

  it('keeps the caller conversation id when the server omits the header', async () => {
    stubFetch({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: streamOf(['[]\fok']),
    })
    const result = await streamChat('q', 'nb-1', 'convo-existing', () => {}, () => {})
    expect(result).toEqual({ conversationId: 'convo-existing' })
  })

  it('reports the daily limit distinctly on 429', async () => {
    stubFetch({
      ok: false,
      status: 429,
      headers: new Headers(),
      body: null,
      text: async () => '{"error":"Daily limit reached"}',
    } as never)
    await expect(streamChat('q', 'nb-1', undefined, () => {}, () => {})).rejects.toThrow(
      /daily limit/i,
    )
  })

  it('refuses to call the function without a session', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    const fetchMock = stubFetch({ ok: true, status: 200, headers: new Headers(), body: null })
    await expect(streamChat('q', 'nb-1', undefined, () => {}, () => {})).rejects.toThrow(/session/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
