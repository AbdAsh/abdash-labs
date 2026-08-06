/**
 * The anti-hallucination gate.
 *
 * A relation survives only if its `quote` clears two independent tests:
 *
 *   1. The quote is a *verbatim* substring of the chunk it came from.
 *   2. The quote actually names one of the two entities the relation is about.
 *
 * Test 1 alone is not enough, and that is the subtle part. A model can copy a
 * real sentence and staple it to a claim the sentence never made — quote
 * "Dr. Sarah Chen founded Helix Labs" in support of "Marcus Webb founded
 * Rotterdam" and every character checks out. The citation is genuine and the
 * claim is invented, which is the worst possible combination because it looks
 * verified. Test 2 anchors the evidence to the claim.
 *
 * Relations that fail either test are dropped — never repaired, never
 * softened, never shown. This is what turns provenance from a claim into a
 * guarantee.
 *
 * The one tolerance in test 1 is whitespace: PDF text extraction sprays line
 * breaks and double spaces through sentences, and no model reproduces those
 * faithfully. So both sides are whitespace-normalised before the substring
 * test. Nothing else is tolerated — not case, not a dropped letter, not an
 * inserted article, not a "co-" prefix on the verb. Word-level fuzziness is
 * precisely where a fabricated citation would hide.
 *
 * Test 2 is deliberately the looser of the two: *one* endpoint, not both.
 * Requiring both would drop "Chen founded Helix Labs" whenever the model named
 * the entity "Dr. Sarah Chen", and surface-form variation is the norm, not the
 * exception — resolving it is the rest of this app's job. One named endpoint is
 * enough to rule out a quote that is about something else entirely.
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

const HONORIFIC = /^(dr|mr|mrs|ms|miss|prof|professor|sir|dame|rev|lord|lady)\s+/

/**
 * The canonical surface form of a name.
 *
 * Lowercases, folds intra-word periods and apostrophes so `U.S.A.` matches
 * `USA` and `O'Brien` matches `OBrien`, turns separating punctuation into
 * spaces so `Jean-Luc` matches `Jean Luc`, collapses whitespace, and strips
 * leading honorifics.
 *
 * It lives here rather than in the resolver because both the gate and the
 * resolver have to agree on what counts as "the same name", and only one of
 * them can own the rule. The gate is the lower layer, so it owns it.
 *
 * Honorific stripping is a person-shaped rule applied without knowing the
 * type, so an artifact literally named "Dr Pepper" normalises to "pepper".
 * That is tolerable precisely because the resolver's type gate keeps it from
 * ever touching a person node.
 */
export function normalizeName(n: string): string {
  let s = String(n ?? '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  for (;;) {
    const stripped = s.replace(HONORIFIC, '')
    if (stripped === s || stripped.length === 0) break
    s = stripped
  }
  return s
}

/**
 * Whole-name containment, case-insensitive and punctuation-tolerant, so "Chen"
 * matches "Chen founded…" but never "Chenille". Honorifics fold on both sides,
 * so the entity "Dr. Sarah Chen" is found in a passage that writes plain
 * "Sarah Chen".
 *
 * Used by the gate to anchor a quote to its relation, and by the split
 * correction to decide which evidence follows an alias — one rule, so a quote
 * that was good enough to create an edge is good enough to keep after a split.
 */
export function nameAppearsIn(text: string, name: string): boolean {
  const haystack = normalizeName(text)
  const needle = normalizeName(name)
  if (!needle || !haystack) return false
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? ' ' : haystack[at - 1]!
    const afterIndex = at + needle.length
    const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex]!
    if (before === ' ' && after === ' ') return true
  }
  return false
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
      containsAtWordBoundary(normalizedChunk, quote) &&
      // Anchored: a real sentence is not evidence for a claim it never mentions.
      (nameAppearsIn(quote, relation.source) || nameAppearsIn(quote, relation.target))
    if (ok) kept.push(relation)
    else dropped.push(relation)
  }

  return { kept, dropped }
}
