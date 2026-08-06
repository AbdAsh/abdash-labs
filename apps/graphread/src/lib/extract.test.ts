import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.hoisted, not bare consts: vi.mock is hoisted above these declarations and
// its factory runs on first import of './extract', which would otherwise hit
// the temporal dead zone. The mock also keeps @labs/platform from constructing
// a real client, which would demand VITE_SUPABASE_URL at import time.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@labs/platform', () => ({ supabase: { functions: { invoke } } }))

import { runExtraction, type RunProgress, type SourceChunk } from './extract'

const TEXT = (n: number) =>
  `Person ${n} founded Org ${n} in 2019. Org ${n} is based in Rotterdam.`

const chunks = (count: number): SourceChunk[] =>
  Array.from({ length: count }, (_, i) => ({ id: `c${i}`, page: i + 1, content: TEXT(i) }))

/** What the function returns for a healthy chunk: two entities, one relation. */
const ok = (chunk: SourceChunk) => {
  const n = Number(chunk.id.slice(1))
  return {
    data: {
      chunkId: chunk.id,
      entities: [
        { name: `Person ${n}`, type: 'person', description: 'A founder.' },
        { name: `Org ${n}`, type: 'organization', description: 'A company.' },
      ],
      relations: [
        {
          source: `Person ${n}`,
          relation: 'founded',
          target: `Org ${n}`,
          quote: `Person ${n} founded Org ${n}`,
        },
      ],
    },
    error: null,
  }
}

const httpError = (status: number, message: string) => ({
  data: null,
  error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    context: new Response(JSON.stringify({ error: message }), { status }),
  }),
})

/** Reads the chunk id out of an invoke call so a mock can answer per chunk. */
const calledChunkId = (call: unknown[]): string =>
  (call[1] as { body: { chunkId: string } }).body.chunkId

// Braces matter: a `beforeEach` that *returns* something callable is treated as
// a teardown hook, and `mockReset()` returns the mock — so the arrow form would
// have vitest calling `invoke()` with no arguments after every test.
beforeEach(() => {
  invoke.mockReset()
})

describe('runExtraction — a chunk that fails', () => {
  it('keeps the graph built from every chunk that did come back', async () => {
    const source = chunks(30)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      // Chunk 12 of 30 dies. The other twenty-nine must survive it.
      return chunk.id === 'c12' ? httpError(500, 'openrouter timed out') : ok(chunk)
    })

    const result = await runExtraction(source, { skipEmbeddingPass: true })

    expect(result.failedChunks).toEqual(['c12'])
    expect(result.extractions).toHaveLength(29)
    expect(result.graph.edges).toHaveLength(29)
    expect(result.graph.nodes).toHaveLength(58)
    // The count of chunks the document *had*, not the count that worked — the
    // stats line must not quietly redefine the document as the part that read.
    expect(result.graph.stats.chunks).toBe(30)
    expect(result.stoppedEarly).toBe(false)
  })

  it('still produces a usable graph when most of the document fails', async () => {
    const source = chunks(10)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      return chunk.id === 'c0' || chunk.id === 'c1' ? ok(chunk) : httpError(502, 'bad gateway')
    })

    const result = await runExtraction(source, { skipEmbeddingPass: true })
    expect(result.failedChunks).toHaveLength(8)
    expect(result.graph.edges).toHaveLength(2)
  })
})

describe('runExtraction — quota', () => {
  it('throws on a first-chunk refusal instead of returning half a document', async () => {
    invoke.mockResolvedValue(httpError(429, 'Daily limit reached for graphread:extractions.'))

    await expect(runExtraction(chunks(30), { skipEmbeddingPass: true })).rejects.toThrow(
      /Daily limit reached/,
    )
    // One request, not thirty. This is the whole reason chunk 0 goes alone.
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('stops asking once the allowance runs out mid-run', async () => {
    const source = chunks(40)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      const n = Number(chunk.id.slice(1))
      return n < 10 ? ok(chunk) : httpError(429, 'Daily limit reached for graphread:chunks.')
    })

    const result = await runExtraction(source, { skipEmbeddingPass: true })

    expect(result.stoppedEarly).toBe(true)
    expect(result.graph.edges).toHaveLength(10)
    // Four workers can each be mid-flight when the first refusal lands, so the
    // bound is loose — but it must be nothing like all forty.
    expect(invoke.mock.calls.length).toBeLessThan(20)
  })

  it('keeps a non-quota failure from ending the run', async () => {
    const source = chunks(6)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      return chunk.id === 'c1' ? httpError(500, 'model returned nothing') : ok(chunk)
    })

    const result = await runExtraction(source, { skipEmbeddingPass: true })
    expect(result.stoppedEarly).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(6)
  })
})

describe('runExtraction — live growth', () => {
  it('reports a graph that only ever grows, so the canvas can animate it', async () => {
    const source = chunks(8)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      return ok(chunk)
    })

    const seen: RunProgress[] = []
    const result = await runExtraction(source, {
      skipEmbeddingPass: true,
      onProgress: (p) => seen.push(p),
    })

    expect(seen).toHaveLength(8)
    expect(seen.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const p of seen) expect(p.total).toBe(8)

    let previous = -1
    for (const p of seen) {
      expect(p.graph.nodes.length).toBeGreaterThanOrEqual(previous)
      previous = p.graph.nodes.length
    }
    expect(result.graph.nodes).toHaveLength(16)
  })

  it('counts a chunk that produced no entities without breaking the run', async () => {
    const source = chunks(4)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      return chunk.id === 'c2'
        ? { data: { chunkId: chunk.id, entities: [], relations: [] }, error: null }
        : ok(chunk)
    })

    const result = await runExtraction(source, { skipEmbeddingPass: true })
    expect(result.failedChunks).toEqual([])
    expect(result.extractions).toHaveLength(4)
    expect(result.graph.edges).toHaveLength(3)
  })

  it('returns an empty graph rather than throwing on a document with no text', async () => {
    const result = await runExtraction([], { skipEmbeddingPass: true })
    expect(result.graph.nodes).toEqual([])
    expect(result.graph.stats.chunks).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('runExtraction — cancellation', () => {
  it('stops early and keeps everything already read', async () => {
    const source = chunks(30)
    const controller = new AbortController()
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      if (chunk.id === 'c5') controller.abort()
      return ok(chunk)
    })

    const result = await runExtraction(source, {
      skipEmbeddingPass: true,
      signal: controller.signal,
    })

    expect(result.stoppedEarly).toBe(true)
    expect(result.extractions.length).toBeLessThan(30)
    expect(result.graph.edges.length).toBe(result.extractions.length)
    // Whatever was read is still a graph, and its stats still describe the
    // document rather than the fragment.
    expect(result.graph.stats.chunks).toBe(30)
  })

  it('charges the per-document quota exactly once, on the first chunk only', async () => {
    const source = chunks(12)
    invoke.mockImplementation(async (_name: string, options: { body: { chunkId: string } }) => {
      const chunk = source.find((c) => c.id === options.body.chunkId)!
      return ok(chunk)
    })

    await runExtraction(source, { skipEmbeddingPass: true })

    const indices = invoke.mock.calls.map(
      (call) => (call[1] as { body: { chunkIndex: number } }).body.chunkIndex,
    )
    expect(indices.filter((i) => i === 0)).toHaveLength(1)
    expect(new Set(indices).size).toBe(12)
    expect(new Set(invoke.mock.calls.map(calledChunkId)).size).toBe(12)
  })
})
