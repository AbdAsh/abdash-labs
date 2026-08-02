/**
 * The anti-hallucination gate.
 *
 * Every relation the model returns must carry a `quote` that is a *verbatim*
 * substring of the chunk it was extracted from. Relations whose quote fails
 * are dropped — never repaired, never softened, never shown. This is what
 * turns provenance from a claim into a guarantee.
 *
 * The one tolerance is whitespace: PDF text extraction sprays line breaks and
 * double spaces through sentences, and no model reproduces those faithfully.
 * So both sides are whitespace-normalised before the substring test.
 *
 * Nothing else is tolerated. Not case, not a dropped letter, not an inserted
 * article, not a "co-" prefix on the verb. Word-level fuzziness is precisely
 * where a fabricated citation would hide, so the gate stays exact there.
 */

export const ENTITY_TYPES = [
  'person',
  'organization',
  'place',
  'concept',
  'event',
  'artifact',
  'date',
] as const

export type EntityType = (typeof ENTITY_TYPES)[number]

export interface RawEntity {
  name: string
  type: EntityType
  description: string
}

export interface RawRelation {
  source: string
  relation: string
  target: string
  quote: string
}

export interface ChunkExtraction {
  chunkId: string
  entities: RawEntity[]
  relations: RawRelation[]
}

/**
 * A quote shorter than this cannot support a claim about two entities — a bare
 * verb ("founded") matches half the document and proves nothing.
 */
export const MIN_QUOTE_WORDS = 3

/** Collapses every run of whitespace — including NBSP, tabs and CRLF — to one space. */
export function normalizeQuote(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function wordCount(normalized: string): number {
  return normalized.length === 0 ? 0 : normalized.split(' ').length
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * A verbatim quote may end before punctuation the model chose not to copy
 * ("merged with Orbit" out of "merged with Orbit."), but it may never end in
 * the middle of a word — "Helix Lab" sliced out of "Helix Labs" is a character
 * substring yet asserts something the document does not. So the match must be
 * flanked by non-word characters on both sides.
 */
function containsAtWordBoundary(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : haystack[at - 1]!
    const afterIndex = at + needle.length
    const after = afterIndex >= haystack.length ? '' : haystack[afterIndex]!
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
  }
  return false
}

/**
 * True when `quote` genuinely appears in `chunkText`, modulo whitespace, and is
 * long enough to be evidence. Exported because the split correction re-checks
 * evidence against an alias using the same standard the gate applies.
 */
export function quoteSupportedBy(quote: unknown, chunkText: string): boolean {
  if (typeof quote !== 'string') return false
  const q = normalizeQuote(quote)
  if (wordCount(q) < MIN_QUOTE_WORDS) return false
  return containsAtWordBoundary(normalizeQuote(chunkText), q)
}

function hasEndpoints(r: RawRelation): boolean {
  return (
    typeof r.source === 'string' &&
    typeof r.target === 'string' &&
    r.source.trim().length > 0 &&
    r.target.trim().length > 0
  )
}

/**
 * Partitions a chunk's relations into those whose quote is verifiable against
 * the chunk text and those that are not. Both halves are returned: the drops
 * are counted and surfaced in the UI rather than quietly discarded, because
 * "we threw away 9 of 44 claims" is itself an honest signal about the model.
 */
export function validateExtraction(
  x: ChunkExtraction,
  chunkText: string,
): { kept: RawRelation[]; dropped: RawRelation[] } {
  const normalizedChunk = normalizeQuote(chunkText)
  const kept: RawRelation[] = []
  const dropped: RawRelation[] = []

  for (const relation of x.relations ?? []) {
    const quote = typeof relation?.quote === 'string' ? normalizeQuote(relation.quote) : ''
    const ok =
      hasEndpoints(relation) &&
      wordCount(quote) >= MIN_QUOTE_WORDS &&
      containsAtWordBoundary(normalizedChunk, quote)
    if (ok) kept.push(relation)
    else dropped.push(relation)
  }

  return { kept, dropped }
}
