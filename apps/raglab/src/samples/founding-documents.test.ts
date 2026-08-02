import { describe, it, expect } from 'vitest'
import { chunkWith, type ChunkerId } from '../lib/chunkers'
import { overlapRatio } from '../lib/metrics'
import {
  SAMPLE_DOC,
  SAMPLE_LABELS,
  SAMPLE_QUESTIONS,
  goldFromQuote,
} from './founding-documents'

const { text } = SAMPLE_DOC

describe('sample document', () => {
  it('is large enough for chunk size to matter and small enough to run fast', () => {
    // Under ~4k characters every config chunks it identically and the benchmark
    // teaches nothing; over ~40k the sample run stops finishing in a minute.
    expect(text.length).toBeGreaterThan(4_000)
    expect(text.length).toBeLessThan(40_000)
  })

  it('has real paragraph structure, so the recursive chunker differs from the others', () => {
    expect(text.split(/\n\s*\n/).length).toBeGreaterThan(20)
  })

  it('declares its provenance and licence', () => {
    expect(SAMPLE_DOC.license).toMatch(/public domain/i)
    expect(SAMPLE_DOC.source).toBeTruthy()
  })
})

describe('goldFromQuote', () => {
  it('rejects a quote that is absent', () => {
    expect(() => goldFromQuote('abc', 'xyz')).toThrow(/not found/i)
  })

  it('rejects a quote that appears twice', () => {
    expect(() => goldFromQuote('abc abc', 'abc')).toThrow(/ambiguous/i)
  })

  it('returns a span that slices back to the quote', () => {
    const span = goldFromQuote('hello world', 'world')
    expect('hello world'.slice(span.start, span.end)).toBe('world')
  })
})

describe('sample gold set', () => {
  it('has fifteen questions', () => {
    expect(SAMPLE_QUESTIONS).toHaveLength(15)
  })

  it('uses unique question ids', () => {
    expect(new Set(SAMPLE_QUESTIONS.map((q) => q.id)).size).toBe(15)
  })

  // The whole point of storing quotes instead of offsets: if the document text is
  // ever edited, this fails loudly rather than silently scoring the wrong span.
  it('locates every gold span exactly once in the document', () => {
    for (const label of SAMPLE_LABELS) {
      expect(text.indexOf(label.quote), `missing: ${label.id}`).toBeGreaterThanOrEqual(0)
      expect(
        text.indexOf(label.quote, text.indexOf(label.quote) + 1),
        `ambiguous: ${label.id}`,
      ).toBe(-1)
    }
  })

  it('slices every gold span back to its hand-written quote', () => {
    for (const [i, q] of SAMPLE_QUESTIONS.entries()) {
      expect(text.slice(q.gold.start, q.gold.end)).toBe(SAMPLE_LABELS[i]!.quote)
    }
  })

  it('gives every question a distinct answer location', () => {
    const keys = SAMPLE_QUESTIONS.map((q) => `${q.gold.start}:${q.gold.end}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never overlaps two gold spans, so no question has two right answers', () => {
    const spans = [...SAMPLE_QUESTIONS].sort((a, b) => a.gold.start - b.gold.start)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.gold.start, `${spans[i]!.id} overlaps ${spans[i - 1]!.id}`)
        .toBeGreaterThanOrEqual(spans[i - 1]!.gold.end)
    }
  })

  it('keeps gold spans short enough to be answerable at a sensible chunk size', () => {
    for (const q of SAMPLE_QUESTIONS) {
      const length = q.gold.end - q.gold.start
      expect(length, `${q.id} is ${length} chars`).toBeGreaterThan(30)
      expect(length, `${q.id} is ${length} chars`).toBeLessThan(400)
    }
  })

  it('asks questions that do not simply restate the answer verbatim', () => {
    // A question containing its own gold passage would be answerable by lexical
    // overlap alone and would flatter every configuration equally.
    for (const [i, q] of SAMPLE_QUESTIONS.entries()) {
      expect(q.text.includes(SAMPLE_LABELS[i]!.quote)).toBe(false)
    }
  })
})

describe('sample benchmark is actually winnable', () => {
  // A gold set every configuration misses is a broken gold set, not a hard one.
  // At each realistic chunk size, some chunk must cover at least half of every
  // gold span, or the sample would report a leaderboard of zeros.
  it('has a covering chunk for every question at every default chunk size', () => {
    for (const id of ['fixed', 'sentence-window', 'recursive'] as ChunkerId[]) {
      for (const size of [400, 800, 1600]) {
        const chunks = chunkWith(id, text, { size, overlap: Math.floor(size / 5) })
        for (const q of SAMPLE_QUESTIONS) {
          const best = Math.max(...chunks.map((c) => overlapRatio(c, q.gold)))
          expect(best, `${id}/${size} cannot reach ${q.id}`).toBeGreaterThanOrEqual(0.5)
        }
      }
    }
  })
})
