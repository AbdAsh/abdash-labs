import type { SpanChunk } from './chunkers'

/**
 * A labelled answer: the character range in the full document text that actually
 * answers a question.
 *
 * Ranges are half-open, `[start, end)`, matching `String.prototype.slice`. This is
 * the single convention the whole app depends on, and the reason a chunk ending
 * exactly at `gold.start` scores zero rather than something.
 */
export interface GoldSpan {
  start: number
  end: number
}

export interface Question {
  id: string
  text: string
  gold: GoldSpan
}

/** A retrieved chunk counts as a hit once it covers half the gold answer. */
export const DEFAULT_THRESHOLD = 0.5

/**
 * How much of the gold answer this chunk contains, from 0 to 1.
 *
 * Intersection over **gold length**, never over chunk length. That asymmetry is
 * the point: a chunk that swallows the whole document contains the whole answer,
 * so it scores 1. Normalising by chunk length would instead punish large chunks
 * for being large and rank a precise-but-wrong chunk above a correct one — which
 * would quietly make the entire leaderboard measure the wrong thing.
 *
 * Precision is not ignored, it is measured elsewhere: `k` is fixed per config, so
 * a chunker that only wins by returning enormous chunks pays for it in the token
 * estimate and in the per-question drill-down, not in a fudged overlap number.
 */
export function overlapRatio(chunk: SpanChunk, gold: GoldSpan): number {
  const goldLength = gold.end - gold.start
  if (goldLength <= 0) return 0
  const intersection = Math.min(chunk.end, gold.end) - Math.max(chunk.start, gold.start)
  if (intersection <= 0) return 0
  return intersection / goldLength
}

/** Inclusive at the threshold: exactly 50% coverage is a hit at 0.5. */
export function isHit(chunk: SpanChunk, gold: GoldSpan, threshold = DEFAULT_THRESHOLD): boolean {
  const ratio = overlapRatio(chunk, gold)
  // A zero threshold still needs real overlap, otherwise every disjoint chunk hits.
  if (ratio <= 0) return false
  return ratio >= threshold
}

/** Did any of the top `k` retrieved chunks hit? */
export function hitAtK(
  ranked: SpanChunk[],
  gold: GoldSpan,
  k: number,
  threshold = DEFAULT_THRESHOLD,
): boolean {
  return ranked.slice(0, Math.max(0, k)).some((c) => isHit(c, gold, threshold))
}

/**
 * 1 / (rank of the first hit), or 0 when nothing hits.
 *
 * The *first* hit, not the best one — MRR models a reader working down the list
 * and stopping at the first useful result.
 */
export function reciprocalRank(
  ranked: SpanChunk[],
  gold: GoldSpan,
  threshold = DEFAULT_THRESHOLD,
): number {
  const rank = ranked.findIndex((c) => isHit(c, gold, threshold))
  return rank === -1 ? 0 : 1 / (rank + 1)
}

/** Mean hit rate and mean reciprocal rank across a question set. */
export function aggregate(
  perQuestion: { hit: boolean; rr: number }[],
): { hitRate: number; mrr: number } {
  if (perQuestion.length === 0) return { hitRate: 0, mrr: 0 }
  const hits = perQuestion.reduce((n, q) => n + (q.hit ? 1 : 0), 0)
  const rrs = perQuestion.reduce((n, q) => n + q.rr, 0)
  return { hitRate: hits / perQuestion.length, mrr: rrs / perQuestion.length }
}
