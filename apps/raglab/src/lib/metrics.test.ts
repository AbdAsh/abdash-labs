import { describe, it, expect } from 'vitest'
import type { SpanChunk } from './chunkers'
import {
  DEFAULT_THRESHOLD,
  aggregate,
  bestOverlap,
  isHit,
  minChunkSizeToHit,
  overlapRatio,
  reciprocalRank,
} from './metrics'

const gold = { start: 100, end: 200 }
const chunk = (start: number, end: number): SpanChunk => ({
  start,
  end,
  content: '',
  page: 1,
  index: 0,
})

describe('overlapRatio', () => {
  it('is 1 when the chunk fully contains the gold span', () => {
    expect(overlapRatio(chunk(0, 500), gold)).toBe(1)
  })

  it('is 1 when the chunk matches the gold span exactly', () => {
    expect(overlapRatio(chunk(100, 200), gold)).toBe(1)
  })

  it('is 0 when disjoint', () => {
    expect(overlapRatio(chunk(0, 99), gold)).toBe(0)
  })

  it('is 0 for a chunk ending exactly at the gold start', () => {
    // Half-open ranges: [0,100) and [100,200) share no character.
    expect(overlapRatio(chunk(0, 100), gold)).toBe(0)
  })

  it('is 0 for a chunk starting exactly at the gold end', () => {
    expect(overlapRatio(chunk(200, 300), gold)).toBe(0)
  })

  it('is 1/100 for a one-character touch at the gold start', () => {
    expect(overlapRatio(chunk(0, 101), gold)).toBeCloseTo(0.01)
  })

  it('is 0.5 for half coverage', () => {
    expect(overlapRatio(chunk(150, 400), gold)).toBe(0.5)
  })

  it('handles a gold span smaller than the chunk boundary offset', () => {
    expect(overlapRatio(chunk(190, 300), gold)).toBeCloseTo(0.1)
  })

  it('divides by gold length, not chunk length', () => {
    // A 10k-character chunk swallowing the gold span still scores a perfect 1.
    // Measuring against chunk length instead would score it 0.01 and rank a
    // useless whole-document chunk below a precise one — the opposite of the truth.
    expect(overlapRatio(chunk(0, 10_000), gold)).toBe(1)
  })

  it('is 0 for a degenerate zero-length gold span rather than NaN', () => {
    expect(overlapRatio(chunk(0, 500), { start: 100, end: 100 })).toBe(0)
  })

  it('is 0 for an inverted gold span rather than negative', () => {
    expect(overlapRatio(chunk(0, 500), { start: 200, end: 100 })).toBe(0)
  })
})

describe('isHit at the threshold boundary', () => {
  it('counts exactly 50% as a hit at the default threshold', () => {
    expect(isHit(chunk(150, 400), gold, 0.5)).toBe(true)
  })

  it('rejects 49%', () => {
    expect(isHit(chunk(151, 400), gold, 0.5)).toBe(false)
  })

  it('uses 0.5 as the default threshold', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.5)
    expect(isHit(chunk(150, 400), gold)).toBe(true)
    expect(isHit(chunk(151, 400), gold)).toBe(false)
  })

  it('treats a zero threshold as any overlap at all', () => {
    expect(isHit(chunk(0, 101), gold, 0)).toBe(true)
    expect(isHit(chunk(0, 100), gold, 0)).toBe(false)
  })

  it('requires total containment at a threshold of 1', () => {
    expect(isHit(chunk(100, 200), gold, 1)).toBe(true)
    expect(isHit(chunk(100, 199), gold, 1)).toBe(false)
  })
})

describe('bestOverlap', () => {
  it('reports the most any single chunk covers, not the sum', () => {
    // Two chunks each covering a different half must not add up to a hit: a hit
    // means one retrieved chunk carried the answer, not that the answer exists
    // somewhere in the union of everything retrieved.
    expect(bestOverlap([chunk(100, 150), chunk(150, 200)], gold)).toBe(0.5)
  })

  it('is 0 when nothing touches the span', () => {
    expect(bestOverlap([chunk(0, 100), chunk(200, 300)], gold)).toBe(0)
  })

  it('is 0 for an empty ranking', () => {
    expect(bestOverlap([], gold)).toBe(0)
  })
})

describe('minChunkSizeToHit', () => {
  // The bound only means anything because no chunker ever emits a chunk larger
  // than its size — asserted in chunkers.test.ts.
  it('is half the gold length at the default threshold', () => {
    expect(minChunkSizeToHit({ start: 0, end: 400 })).toBe(200)
  })

  it('rounds up when half the span is not a whole number', () => {
    expect(minChunkSizeToHit({ start: 0, end: 401 })).toBe(201)
    // 200 characters of a 401-character answer is 49.9%, under the threshold.
    expect(isHit(chunk(0, 200), { start: 0, end: 401 })).toBe(false)
    expect(isHit(chunk(0, 201), { start: 0, end: 401 })).toBe(true)
  })

  it('agrees with isHit at every threshold, despite float multiplication', () => {
    // `0.7 * 100` is 70.00000000000001 in IEEE 754. Trusting that product would
    // demand 71 characters for a span that 70 already covers, and the UI would
    // tell a user a reachable question is impossible.
    for (const threshold of [0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      for (const length of [7, 10, 33, 100, 101, 250, 401]) {
        const span = { start: 0, end: length }
        const min = minChunkSizeToHit(span, threshold)
        expect(isHit(chunk(0, min), span, threshold)).toBe(true)
        if (min > 1) expect(isHit(chunk(0, min - 1), span, threshold)).toBe(false)
      }
    }
  })

  it('never returns zero, so no size can look sufficient for an empty span', () => {
    expect(minChunkSizeToHit({ start: 5, end: 5 })).toBe(1)
  })
})

describe('reciprocalRank', () => {
  it('is 1 when the first result hits', () => {
    expect(reciprocalRank([chunk(100, 200), chunk(0, 50)], gold)).toBe(1)
  })

  it('is 1/3 when the third result hits', () => {
    expect(
      reciprocalRank([chunk(0, 50), chunk(50, 100), chunk(100, 200)], gold),
    ).toBeCloseTo(1 / 3)
  })

  it('is 0 when nothing hits', () => {
    expect(reciprocalRank([chunk(0, 50), chunk(50, 100)], gold)).toBe(0)
  })

  it('is 0 for an empty ranking', () => {
    expect(reciprocalRank([], gold)).toBe(0)
  })

  it('scores the first hit, not the best one', () => {
    // A partial hit at rank 1 outranks a perfect one at rank 2: MRR measures
    // where the user stops reading, not which chunk was nicest.
    expect(reciprocalRank([chunk(150, 400), chunk(100, 200)], gold)).toBe(1)
  })
})

describe('aggregate', () => {
  it('averages hit rate and reciprocal rank independently', () => {
    expect(
      aggregate([
        { hit: true, rr: 1 },
        { hit: true, rr: 0.5 },
        { hit: false, rr: 0 },
        { hit: false, rr: 0 },
      ]),
    ).toEqual({ hitRate: 0.5, mrr: 0.375 })
  })

  it('returns zeros for an empty question set rather than NaN', () => {
    expect(aggregate([])).toEqual({ hitRate: 0, mrr: 0 })
  })
})
