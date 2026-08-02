import { describe, it, expect } from 'vitest'
import type { ConfigResult } from './engine'
import { MAX_RESULTS_BYTES, VectorLeakError, assertNoVectors, makeSlug } from './persist'

const result = (over: Partial<ConfigResult> = {}): ConfigResult => ({
  config: { chunker: 'fixed', size: 800, overlap: 160, model: 'text-embedding-3-small', k: 5 },
  hitRate: 0.8,
  mrr: 0.72,
  chunkCount: 24,
  perQuestion: [
    { questionId: 'q1', hit: true, rr: 1, retrieved: ['an excerpt'], spans: [[0, 10]] },
  ],
  ...over,
})

describe('assertNoVectors', () => {
  it('accepts a normal metrics payload', () => {
    expect(() => assertNoVectors([result(), result()])).not.toThrow()
  })

  it('accepts an empty result set', () => {
    expect(() => assertNoVectors([])).not.toThrow()
  })

  // The single unrecoverable mistake in this project: once vectors reach the
  // shared 500 MB database, the other six apps lose their budget.
  it('rejects a payload carrying an embedding', () => {
    const leaked = result() as ConfigResult & { vectors?: number[][] }
    leaked.vectors = [Array.from({ length: 1536 }, (_, i) => i / 1000 + 0.0001)]
    expect(() => assertNoVectors([leaked])).toThrow(VectorLeakError)
  })

  it('rejects an embedding hidden inside a per-question record', () => {
    const smuggled = result({
      perQuestion: [{
        questionId: 'q1',
        hit: true,
        rr: 1,
        retrieved: ['ok'],
        spans: [[0, 1]],
        ...({ queryVector: Array.from({ length: 64 }, (_, i) => i / 100 + 0.5) } as object),
      }],
    })
    expect(() => assertNoVectors([smuggled])).toThrow(/embedding/i)
  })

  // Real embeddings contain the occasional exact 1, 0 or exponential value, and a
  // regex over the serialised JSON silently lets those through.
  it('rejects a vector that stringifies with integers and exponentials mixed in', () => {
    const awkward = [0, 1, -1, 1e-7, ...Array.from({ length: 60 }, (_, i) => i / 97 - 0.5)]
    const leaked = result() as ConfigResult & { vectors?: number[][] }
    leaked.vectors = [awkward]
    expect(() => assertNoVectors([leaked])).toThrow(VectorLeakError)
  })

  it('does not mistake short integer span arrays for vectors', () => {
    const spans = Array.from({ length: 200 }, (_, i) => [i, i + 10] as [number, number])
    expect(() => assertNoVectors([result({
      perQuestion: [{ questionId: 'q', hit: true, rr: 1, retrieved: [], spans }],
    })])).not.toThrow()
  })

  it('does not mistake a handful of metric floats for a vector', () => {
    const many = Array.from({ length: 12 }, (_, i) => result({ mrr: i / 13 }))
    expect(() => assertNoVectors(many)).not.toThrow()
  })

  it('rejects a payload above the size cap even if it holds no floats', () => {
    const fat = result({
      perQuestion: Array.from({ length: 800 }, (_, i) => ({
        questionId: `q${i}`,
        hit: true,
        rr: 1,
        retrieved: [`x`.repeat(390)],
        spans: [[0, 1] as [number, number]],
      })),
    })
    expect(() => assertNoVectors([fat])).toThrow(new RegExp(String(MAX_RESULTS_BYTES)))
  })

  it('rejects an over-long drill-down excerpt', () => {
    expect(() => assertNoVectors([result({
      perQuestion: [{
        questionId: 'q', hit: true, rr: 1, retrieved: ['x'.repeat(401)], spans: [[0, 1]],
      }],
    })])).toThrow(/excerpt/i)
  })
})

describe('makeSlug', () => {
  it('is url-safe and short', () => {
    expect(makeSlug()).toMatch(/^[0-9a-z]{12}$/)
  })

  it('does not repeat across a thousand draws', () => {
    const slugs = new Set(Array.from({ length: 1000 }, makeSlug))
    expect(slugs.size).toBe(1000)
  })
})
