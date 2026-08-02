import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { ChunkerId, ChunkerParams } from './chunkers'
import {
  cacheKey,
  cacheSize,
  clearCache,
  getCached,
  putCached,
  quantize,
} from './cache'

const base: { fp: string; chunker: ChunkerId; p: ChunkerParams; model: string } = {
  fp: 'a'.repeat(64),
  chunker: 'fixed',
  p: { size: 800, overlap: 160 },
  model: 'text-embedding-3-small',
}

const key = (o: Partial<typeof base> = {}) => {
  const m = { ...base, ...o }
  return cacheKey(m.fp, m.chunker, m.p, m.model)
}

describe('cacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(key()).toBe(key())
  })

  // A collision here does not throw, it silently serves one config's vectors to
  // another and produces a benchmark that looks fine and is entirely wrong.
  // Every input must therefore move the key.
  it('changes when the document fingerprint changes', () => {
    expect(key({ fp: 'b'.repeat(64) })).not.toBe(key())
  })

  it('changes when the chunker changes', () => {
    expect(key({ chunker: 'recursive' })).not.toBe(key())
    expect(key({ chunker: 'sentence-window' })).not.toBe(key())
  })

  it('changes when the size changes', () => {
    expect(key({ p: { size: 801, overlap: 160 } })).not.toBe(key())
  })

  it('changes when the overlap changes', () => {
    expect(key({ p: { size: 800, overlap: 161 } })).not.toBe(key())
  })

  it('changes when the embedding model changes', () => {
    expect(key({ model: 'text-embedding-3-large' })).not.toBe(key())
  })

  it('gives every distinct config in a full matrix a distinct key', () => {
    const keys = new Set<string>()
    let n = 0
    for (const chunker of ['fixed', 'sentence-window', 'recursive'] as ChunkerId[]) {
      for (const size of [400, 800, 1600]) {
        for (const overlap of [0, 80, 160]) {
          for (const model of ['text-embedding-3-small', 'text-embedding-3-large']) {
            keys.add(cacheKey(base.fp, chunker, { size, overlap }, model))
            n++
          }
        }
      }
    }
    expect(keys.size).toBe(n)
  })

  it('cannot be collided by smuggling the delimiter through a field', () => {
    // Naive `${a}|${b}` concatenation makes these two identical.
    const a = cacheKey('doc', 'fixed', { size: 8, overlap: 0 }, 'model|x')
    const b = cacheKey('doc', 'fixed', { size: 8, overlap: 0 }, 'model')
    expect(a).not.toBe(b)
    expect(cacheKey('x|y', 'fixed', base.p, 'm')).not.toBe(cacheKey('x', 'fixed', base.p, 'y|m'))
  })

  it('carries a version prefix so a format change cannot read stale entries', () => {
    expect(key()).toMatch(/^raglab:v\d+\|/)
  })
})

describe('quantize', () => {
  it('is idempotent, so a cache hit and a cache miss score identically', () => {
    const raw = [[0.1234567890123, -0.98765432109, 0.5]]
    const once = quantize(raw)
    expect(quantize(once)).toEqual(once)
  })

  it('preserves shape', () => {
    expect(quantize([[1, 2, 3], [4, 5, 6]])).toHaveLength(2)
    expect(quantize([[1, 2, 3]])[0]).toHaveLength(3)
  })

  it('stays close to the input', () => {
    expect(quantize([[0.1234567890123]])[0]![0]).toBeCloseTo(0.1234567890123, 6)
  })
})

describe('indexeddb storage', () => {
  beforeEach(async () => {
    await clearCache()
  })

  it('round-trips a vector set', async () => {
    const vectors = [
      [0.5, -0.25, 0.125],
      [1, 0, -1],
    ]
    await putCached(key(), vectors)
    expect(await getCached(key())).toEqual(quantize(vectors))
  })

  it('returns null for a key that was never written', async () => {
    expect(await getCached(key({ fp: 'never-written' }))).toBeNull()
  })

  it('keeps two configs apart', async () => {
    await putCached(key(), [[1, 0]])
    await putCached(key({ chunker: 'recursive' }), [[0, 1]])
    expect(await getCached(key())).toEqual([[1, 0]])
    expect(await getCached(key({ chunker: 'recursive' }))).toEqual([[0, 1]])
  })

  it('overwrites rather than duplicating on a repeated put', async () => {
    await putCached(key(), [[1, 0]])
    await putCached(key(), [[0, 1]])
    expect(await getCached(key())).toEqual([[0, 1]])
    expect((await cacheSize()).entries).toBe(1)
  })

  it('reports a size that grows with what was stored', async () => {
    const empty = await cacheSize()
    expect(empty).toEqual({ entries: 0, approxBytes: 0 })

    await putCached(key(), [Array.from({ length: 1536 }, () => 0.1)])
    const one = await cacheSize()
    expect(one.entries).toBe(1)
    // 1536 float32 values is 6 KB of payload; the estimate must be in that region,
    // because this number is what tells a user why their browser storage is full.
    expect(one.approxBytes).toBeGreaterThanOrEqual(1536 * 4)
    expect(one.approxBytes).toBeLessThan(1536 * 4 * 2)

    await putCached(key({ model: 'text-embedding-3-large' }), [Array.from({ length: 3072 }, () => 0.1)])
    const two = await cacheSize()
    expect(two.entries).toBe(2)
    expect(two.approxBytes).toBeGreaterThan(one.approxBytes)
  })

  it('empties completely on clear', async () => {
    await putCached(key(), [[1, 2, 3]])
    await clearCache()
    expect(await cacheSize()).toEqual({ entries: 0, approxBytes: 0 })
    expect(await getCached(key())).toBeNull()
  })

  it('handles an empty vector set without corrupting the entry', async () => {
    await putCached(key(), [])
    expect(await getCached(key())).toEqual([])
  })

  it('survives a realistic 3072-dimension batch', async () => {
    const vectors = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 3072 }, (_, j) => Math.sin(i * 3072 + j)))
    await putCached(key(), vectors)
    const back = await getCached(key())
    expect(back).toHaveLength(40)
    expect(back![0]).toHaveLength(3072)
    expect(back).toEqual(quantize(vectors))
  })
})
