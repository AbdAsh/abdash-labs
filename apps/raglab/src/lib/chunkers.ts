import type { Chunk, Page } from '@labs/doc-core'

/**
 * A chunk that knows exactly where it came from.
 *
 * `doc-core`'s `Chunk` is enough for Recto, which only ever needs the text and a
 * page number. RAG Lab needs more: gold answers are labelled as character ranges
 * into the *full document text*, so a chunk must carry the same coordinate system
 * for overlap to be computable across two different chunkings of one document.
 * That is the whole reason the metrics in this app are comparable at all.
 *
 * The invariant every chunker here must uphold, enforced in `chunkers.test.ts`:
 *
 *     text.slice(chunk.start, chunk.end) === chunk.content
 *
 * Chunk content is therefore never trimmed or normalised. Leading whitespace on a
 * chunk is not a bug; discarding it would break the invariant and silently
 * invalidate every hit@k and MRR number the tool reports.
 */
export interface SpanChunk extends Chunk {
  /** Inclusive character offset into the full document text. */
  start: number
  /** Exclusive character offset into the full document text. */
  end: number
}

export type ChunkerId = 'fixed' | 'sentence-window' | 'recursive'

export interface ChunkerParams {
  /** Maximum characters per chunk. Never exceeded, including on hard wraps. */
  size: number
  /** Characters of context repeated between neighbouring chunks. */
  overlap: number
}

export const CHUNKERS: { id: ChunkerId; label: string; blurb: string }[] = [
  {
    id: 'fixed',
    label: 'Fixed size',
    blurb: 'Blind character windows. The baseline everyone actually ships.',
  },
  {
    id: 'sentence-window',
    label: 'Sentence window',
    blurb: 'Packs whole sentences up to the size budget. Never splits mid-sentence.',
  },
  {
    id: 'recursive',
    label: 'Recursive',
    blurb: 'Paragraph first, then sentence, then hard wrap. Never crosses a paragraph.',
  },
]

/** Display name for a chunker. One lookup, so the table, chart and errors agree. */
export function chunkerLabel(id: ChunkerId | string): string {
  return CHUNKERS.find((c) => c.id === id)?.label ?? id
}

/** Half-open character range. */
interface Span {
  start: number
  end: number
}

function assertParams(p: ChunkerParams): void {
  if (!Number.isFinite(p.size) || p.size <= 0) {
    throw new RangeError(`chunker size must be a positive number, got ${p.size}`)
  }
  if (!Number.isFinite(p.overlap) || p.overlap < 0) {
    throw new RangeError(`chunker overlap must be zero or greater, got ${p.overlap}`)
  }
  if (p.overlap >= p.size) {
    // step = size - overlap; a non-positive step never terminates.
    throw new RangeError(`chunker overlap (${p.overlap}) must be smaller than size (${p.size})`)
  }
}

/**
 * Sliding character windows over `[from, to)`. Contiguous when overlap is 0, and
 * the final window always ends exactly at `to`, so the chunking covers the range
 * with no tail left behind.
 */
function fixedSpans(from: number, to: number, size: number, overlap: number): Span[] {
  const step = size - overlap
  const out: Span[] = []
  for (let start = from; start < to; start += step) {
    const end = Math.min(start + size, to)
    out.push({ start, end })
    if (end === to) break
  }
  return out
}

/**
 * Sentence spans covering `[from, to)` with no gaps.
 *
 * A boundary sits after a run of terminators plus any closing quotes or brackets,
 * when followed by whitespace or the end of the range. Trailing whitespace stays
 * attached to the *following* sentence, which keeps the spans contiguous — the
 * cheapest way to guarantee full coverage of the document.
 */
function sentenceSpans(text: string, from: number, to: number): Span[] {
  const out: Span[] = []
  let start = from
  for (let i = from; i < to; i++) {
    if (!'.!?'.includes(text[i]!)) continue
    let j = i
    while (j + 1 < to && '.!?'.includes(text[j + 1]!)) j++
    while (j + 1 < to && '"\')]»”’'.includes(text[j + 1]!)) j++
    const next = text[j + 1]
    if (j + 1 < to && next !== undefined && !/\s/.test(next)) {
      i = j
      continue
    }
    out.push({ start, end: j + 1 })
    start = j + 1
    i = j
  }
  if (start < to) out.push({ start, end: to })
  return out
}

/** Paragraph spans covering `[0, text.length)`. A blank-line run closes a paragraph. */
function paragraphSpans(text: string): Span[] {
  const out: Span[] = []
  const re = /\n[ \t]*\n\s*/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    out.push({ start, end })
    start = end
  }
  if (start < text.length) out.push({ start, end: text.length })
  return out
}

/**
 * The atomic pieces a window may be built from inside `[from, to)`: whole
 * sentences where they fit, hard-wrapped slices where a single sentence is longer
 * than the entire budget. Contiguous and never larger than `size`.
 */
function unitSpans(text: string, from: number, to: number, size: number): Span[] {
  const out: Span[] = []
  for (const s of sentenceSpans(text, from, to)) {
    if (s.end - s.start <= size) out.push(s)
    else out.push(...fixedSpans(s.start, s.end, size, 0))
  }
  return out
}

/**
 * Greedily packs consecutive units into windows of at most `size` characters,
 * stepping back by whole units to honour the overlap budget.
 *
 * Two guarantees matter here. Every emitted window ends strictly later than the
 * previous one — a maximal greedy fill starting from a later unit can otherwise
 * stop at the same unit and emit a pure subset of the window before it, which
 * wastes an embedding and produces duplicate rows in the drill-down. And the
 * start index advances on every iteration, so the loop always terminates.
 */
function packUnits(units: Span[], size: number, overlap: number): Span[] {
  const out: Span[] = []
  let i = 0
  let lastEnd = -1
  while (i < units.length) {
    const start = units[i]!.start
    let j = i
    while (j + 1 < units.length && units[j + 1]!.end - start <= size) j++

    if (units[j]!.end <= lastEnd) {
      // This window would not extend past the previous one. Skip past it instead.
      i = j + 1
      continue
    }

    const end = units[j]!.end
    out.push({ start, end })
    lastEnd = end

    let next = j + 1
    if (overlap > 0) {
      while (next > i + 1 && end - units[next - 1]!.start <= overlap) next--
    }
    i = Math.max(i + 1, next)
  }
  return out
}

function spansFor(id: ChunkerId, text: string, p: ChunkerParams): Span[] {
  switch (id) {
    case 'fixed':
      // Deliberately blind to structure — this is the control condition, and it is
      // also what Recto currently ships (1600/320), so it has to stay honest.
      return fixedSpans(0, text.length, p.size, p.overlap)

    case 'sentence-window':
      return packUnits(unitSpans(text, 0, text.length, p.size), p.size, p.overlap)

    case 'recursive': {
      // Paragraph boundaries are hard walls: a window never straddles two
      // paragraphs, which is the only behavioural difference from sentence-window
      // and the reason the two can score differently on structured documents.
      const out: Span[] = []
      for (const para of paragraphSpans(text)) {
        if (para.end - para.start <= p.size) {
          out.push(para)
          continue
        }
        out.push(...packUnits(unitSpans(text, para.start, para.end, p.size), p.size, p.overlap))
      }
      return out
    }
  }
}

/** Resolves the 1-based page a character offset falls on. */
function pageAt(pageStarts: number[] | undefined, offset: number): number {
  if (!pageStarts || pageStarts.length === 0) return 1
  let lo = 0
  let hi = pageStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pageStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * Chunks a document with one of the three families, tagging every chunk with the
 * character range it occupies in `text`.
 *
 * `pageStarts` comes from `joinPages` and is optional: a plain-text document has
 * no pages, and everything lands on page 1.
 */
export function chunkWith(
  id: ChunkerId,
  text: string,
  p: ChunkerParams,
  pageStarts?: number[],
): SpanChunk[] {
  assertParams(p)
  if (text.trim().length === 0) return []

  return spansFor(id, text, p).map((s, index) => ({
    content: text.slice(s.start, s.end),
    page: pageAt(pageStarts, s.start),
    index,
    start: s.start,
    end: s.end,
  }))
}

/**
 * Flattens extracted pages into the single string the whole app measures against.
 *
 * Gold spans, chunk spans and the rendered document all use these offsets, so the
 * join has to happen exactly once and never be recomputed with different glue.
 * `pageStarts[i]` is where page `i + 1` begins.
 */
export function joinPages(pages: Page[]): { text: string; pageStarts: number[] } {
  const GLUE = '\n\n'
  const pageStarts: number[] = []
  let text = ''
  for (const page of pages) {
    if (text.length > 0) text += GLUE
    pageStarts.push(text.length)
    text += page.text
  }
  return { text, pageStarts }
}
