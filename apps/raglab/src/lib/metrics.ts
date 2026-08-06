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
  /**
   * The gold passage itself, carried for display only and never read by scoring.
   *
   * A permalink is viewed without the document — the visitor has a slug, not a
   * PDF — so without this the drill-down can name a question and not show the
   * answer it was looking for, which is most of what makes the drill-down
   * readable. Truncated on save; see `MAX_GOLD_TEXT` in `persist.ts`.
   */
  goldText?: string
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

/** The most of the gold answer any one of these chunks manages to contain. */
export function bestOverlap(chunks: SpanChunk[], gold: GoldSpan): number {
  let best = 0
  for (const c of chunks) {
    const ratio = overlapRatio(c, gold)
    if (ratio > best) best = ratio
  }
  return best
}

/**
 * The smallest chunk size at which this gold span can be hit *at all*.
 *
 * Every chunker here emits chunks of at most `size` characters — asserted in
 * `chunkers.test.ts` — and a hit needs one chunk covering `threshold` of the gold
 * span. So when `size < threshold × goldLength` a hit is arithmetically
 * impossible: no embedding model, no `k`, and no amount of overlap can produce
 * one. Reporting that as a miss blames retrieval for what is really a mismatch
 * between how the answer was labelled and how the document was cut, and sends the
 * reader off tuning the wrong knob.
 */
export function minChunkSizeToHit(gold: GoldSpan, threshold = DEFAULT_THRESHOLD): number {
  const goldLength = Math.max(0, gold.end - gold.start)
  if (goldLength === 0) return 1
  const ceiling = Math.ceil(threshold * goldLength)
  // Float drift: `0.7 * 100` is 70.00000000000001, which would demand 71
  // characters for a span that 70 already covers. Settle it with the same
  // division `overlapRatio` performs rather than trusting the multiplication.
  if (ceiling > 1 && (ceiling - 1) / goldLength >= threshold) return ceiling - 1
  return Math.max(1, ceiling)
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
