import { describe, it, expect } from 'vitest'
import type { ConfigResult, PerQuestionResult } from './engine'
import {
  MAX_GOLD_TEXT,
  MAX_RESULTS_BYTES,
  VectorLeakError,
  assertNoVectors,
  makeSlug,
  normaliseQuestions,
  normaliseResults,
  withGoldText,
} from './persist'

const pq = (over: Partial<PerQuestionResult> = {}): PerQuestionResult => ({
  questionId: 'q1',
  hit: true,
  rr: 1,
  retrieved: ['an excerpt'],
  spans: [[0, 10]],
  firstHitRank: 1,
  bestOverlap: 1,
  ...over,
})

const result = (over: Partial<ConfigResult> = {}): ConfigResult => ({
  config: { chunker: 'fixed', size: 800, overlap: 160, model: 'text-embedding-3-small', k: 5 },
  hitRate: 0.8,
  mrr: 0.72,
  chunkCount: 24,
  perQuestion: [pq()],
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
      perQuestion: [pq({
        ...({ queryVector: Array.from({ length: 64 }, (_, i) => i / 100 + 0.5) } as object),
      })],
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
      perQuestion: [pq({ retrieved: [], spans })],
    })])).not.toThrow()
  })

  it('does not mistake a handful of metric floats for a vector', () => {
    const many = Array.from({ length: 12 }, (_, i) => result({ mrr: i / 13 }))
    expect(() => assertNoVectors(many)).not.toThrow()
  })

  it('rejects a payload above the size cap even if it holds no floats', () => {
    const fat = result({
      perQuestion: Array.from({ length: 800 }, (_, i) =>
        pq({ questionId: `q${i}`, retrieved: ['x'.repeat(390)] })),
    })
    expect(() => assertNoVectors([fat])).toThrow(new RegExp(String(MAX_RESULTS_BYTES)))
  })

  it('rejects an over-long drill-down excerpt', () => {
    expect(() => assertNoVectors([result({
      perQuestion: [pq({ retrieved: ['x'.repeat(401)] })],
    })])).toThrow(/excerpt/i)
  })
})

/**
 * A permalink is read long after it was written, so the reader is routinely a
 * different version of the code than the writer. These assert the v1 shape — no
 * `firstHitRank`, no `bestOverlap`, no `goldText` — still renders.
 */
describe('normaliseResults', () => {
  const v1 = [{
    config: { chunker: 'fixed', size: 800, overlap: 160, model: 'text-embedding-3-small', k: 5 },
    hitRate: 0.5,
    mrr: 0.4,
    chunkCount: 24,
    perQuestion: [
      { questionId: 'q1', hit: true, rr: 0.25, retrieved: ['x'], spans: [[0, 10]] },
      { questionId: 'q2', hit: false, rr: 0, retrieved: [], spans: [] },
    ],
  }]

  it('recovers the rank of a hit from rr, which is 1/rank by definition', () => {
    const [r] = normaliseResults(v1)
    expect(r!.perQuestion[0]!.firstHitRank).toBe(4)
  })

  it('leaves a missed question with no rank rather than inventing one', () => {
    // A run written before the field existed never looked past k, so where the
    // answer actually sat is genuinely unknown for a miss.
    const [r] = normaliseResults(v1)
    expect(r!.perQuestion[1]!.firstHitRank).toBeNull()
  })

  it('reports an unrecorded overlap as null, never as a measured zero', () => {
    const [r] = normaliseResults(v1)
    expect(r!.perQuestion[0]!.bestOverlap).toBeNull()
  })

  it('keeps the values a current run does record', () => {
    const [r] = normaliseResults([{
      ...v1[0],
      perQuestion: [{ ...v1[0]!.perQuestion[0], firstHitRank: 9, bestOverlap: 0.42 }],
    }])
    expect(r!.perQuestion[0]).toMatchObject({ firstHitRank: 9, bestOverlap: 0.42 })
  })

  it('survives arrays, nulls and objects where fields should be', () => {
    expect(normaliseResults(null)).toEqual([])
    expect(normaliseResults({})).toEqual([])
    expect(normaliseResults([null, 42, 'x'])).toEqual([])
    // No config means nothing can be labelled, ranked or charted for that row.
    expect(normaliseResults([{ hitRate: 1, mrr: 1 }])).toEqual([])
  })

  it('gives every reader an array to iterate, whatever was stored', () => {
    const [r] = normaliseResults([{ config: { chunker: 'fixed' } }])
    expect(r!.perQuestion).toEqual([])
    expect(r!.chunkCount).toBe(0)
    const [s] = normaliseResults([{ config: { chunker: 'fixed' }, perQuestion: [{}] }])
    expect(s!.perQuestion[0]!.retrieved).toEqual([])
    expect(s!.perQuestion[0]!.spans).toEqual([])
    expect(s!.perQuestion[0]!.hit).toBe(false)
  })
})

describe('normaliseQuestions', () => {
  it('accepts a v1 question with no stored passage', () => {
    const [q] = normaliseQuestions([{ id: 'q1', text: 'why?', gold: { start: 0, end: 9 } }])
    expect(q).toEqual({ id: 'q1', text: 'why?', gold: { start: 0, end: 9 } })
    expect('goldText' in q!).toBe(false)
  })

  it('keeps the passage when a newer run stored one', () => {
    const [q] = normaliseQuestions([
      { id: 'q1', text: 'why?', gold: { start: 0, end: 9 }, goldText: 'because' },
    ])
    expect(q!.goldText).toBe('because')
  })

  it('drops an entry with no usable gold span instead of rendering a broken row', () => {
    expect(normaliseQuestions([
      { id: 'q1' },
      { gold: { start: 0, end: 9 } },
      { id: 'q2', gold: { start: 'nope', end: 9 } },
      null,
    ])).toEqual([])
  })
})

describe('withGoldText', () => {
  const text = 'Alpha beta gamma. '.repeat(40)

  it('carries the passage so a permalink can show it without the document', () => {
    const [q] = withGoldText(text, [{ id: 'q1', text: 'why?', gold: { start: 18, end: 36 } }])
    expect(q!.goldText).toBe(text.slice(18, 36))
  })

  it('leaves the offsets alone', () => {
    // They index the document, not the excerpt. Rewriting them to match a
    // truncation would corrupt the one coordinate system the app agrees on.
    const gold = { start: 5, end: 900 }
    const [q] = withGoldText(text, [{ id: 'q1', text: 'why?', gold }])
    expect(q!.gold).toEqual(gold)
  })

  it('truncates a gold span that covers most of the document', () => {
    // A user-drawn span can legitimately be half the document. Fifteen of those
    // would push the question set past its 64 KB budget and fail the save at the
    // very end of a run that has already been paid for.
    const [q] = withGoldText(text, [{ id: 'q1', text: 'why?', gold: { start: 0, end: 700 } }])
    expect(q!.goldText!.length).toBe(MAX_GOLD_TEXT)
    expect(q!.goldText!.endsWith('…')).toBe(true)
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
