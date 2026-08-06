import { describe, it, expect } from 'vitest'
import {
  EmbedError,
  createEmbedder,
  planBatches,
  type EmbedRequest,
  type EmbedResponse,
} from './embed'

describe('planBatches', () => {
  it('keeps everything in one batch when it fits', () => {
    expect(planBatches(['a', 'b', 'c'], 200, 1000)).toEqual([[0, 1, 2]])
  })

  it('splits on the text-count cap', () => {
    expect(planBatches(['a', 'b', 'c', 'd', 'e'], 2, 1000)).toEqual([[0, 1], [2, 3], [4]])
  })

  it('splits on the character cap', () => {
    expect(planBatches(['aaaa', 'bbbb', 'cc'], 200, 8)).toEqual([[0, 1], [2]])
  })

  it('covers every input exactly once, in order', () => {
    const texts = Array.from({ length: 57 }, (_, i) => 'x'.repeat(i + 1))
    const flat = planBatches(texts, 10, 120).flat()
    expect(flat).toEqual(texts.map((_, i) => i))
  })

  it('returns nothing for no input', () => {
    expect(planBatches([], 10, 100)).toEqual([])
  })

  it('rejects a single text above the character cap rather than truncating it', () => {
    expect(() => planBatches(['x'.repeat(11)], 10, 10)).toThrow(EmbedError)
    expect(() => planBatches(['x'.repeat(11)], 10, 10)).toThrow(/cap/i)
  })
})

describe('createEmbedder', () => {
  const stub = (
    onCall: (body: EmbedRequest) => void = () => {},
  ) => async (body: EmbedRequest): Promise<EmbedResponse> => {
    onCall(body)
    return { vectors: body.texts.map((t) => [t.length]), runId: 'run-1' }
  }

  it('returns nothing for no input without calling the server', async () => {
    let calls = 0
    const embed = createEmbedder(stub(() => { calls++ }))
    expect(await embed([], 'text-embedding-3-small')).toEqual([])
    expect(calls).toBe(0)
  })

  it('preserves input order across batch boundaries', async () => {
    const texts = Array.from({ length: 450 }, (_, i) => 'x'.repeat(i + 1))
    const embed = createEmbedder(stub())
    const vectors = await embed(texts, 'text-embedding-3-small')
    expect(vectors).toHaveLength(450)
    // Vector i must still describe text i after three round trips.
    expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length))
  })

  // Quota is charged per run. Sending no runId on every batch would charge a
  // twelve-config benchmark twelve-plus times and exhaust an anonymous visitor's
  // two daily runs on their first click.
  it('omits runId on the first batch and reuses the minted one afterwards', async () => {
    const seen: (string | undefined)[] = []
    const embed = createEmbedder(stub((b) => seen.push(b.runId)))
    await embed(Array.from({ length: 450 }, () => 'x'), 'text-embedding-3-small')
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0]).toBeUndefined()
    expect(seen.slice(1).every((id) => id === 'run-1')).toBe(true)
  })

  it('carries the run across separate calls for different models', async () => {
    const seen: (string | undefined)[] = []
    const embed = createEmbedder(stub((b) => seen.push(b.runId)))
    await embed(['a'], 'text-embedding-3-small')
    await embed(['b'], 'text-embedding-3-large')
    expect(seen).toEqual([undefined, 'run-1'])
  })

  it('passes the requested model through unchanged', async () => {
    const models: string[] = []
    const embed = createEmbedder(stub((b) => models.push(b.model)))
    await embed(['a'], 'text-embedding-3-large')
    expect(models).toEqual(['text-embedding-3-large'])
  })

  it('refuses a response whose vector count does not match the batch', async () => {
    const embed = createEmbedder(async () => ({ vectors: [[1]], runId: 'r' }))
    await expect(embed(['a', 'b'], 'text-embedding-3-small')).rejects.toThrow(/misaligned/i)
  })

  it('refuses a response with more vectors than the batch, not just fewer', async () => {
    // An extra vector shifts nothing on its own, but it means the proxy and the
    // client disagree about the batch, and every score after that point is a
    // guess about which text produced which vector.
    const embed = createEmbedder(async () => ({ vectors: [[1], [2], [3]], runId: 'r' }))
    await expect(embed(['a', 'b'], 'text-embedding-3-small')).rejects.toThrow(/misaligned/i)
  })

  // A run over a hundred-page document is fifteen or twenty batches. If the
  // fourteenth fails, `out` holds thirteen batches of real vectors and a tail of
  // holes; returning it would score most of the document against `undefined`.
  it('rejects outright when a batch fails partway through, never a holed array', async () => {
    let call = 0
    const embed = createEmbedder(async (body) => {
      if (++call === 3) throw new EmbedError('502 Bad Gateway', 502)
      return { vectors: body.texts.map((t) => [t.length]), runId: 'run-1' }
    })
    const texts = Array.from({ length: 450 }, (_, i) => 'x'.repeat(i + 1))
    await expect(embed(texts, 'text-embedding-3-small')).rejects.toThrow(/502/)
    expect(call).toBe(3)
  })
})
