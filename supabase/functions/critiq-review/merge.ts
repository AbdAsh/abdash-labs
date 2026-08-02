/**
 * Merges deterministic findings with LLM judgment.
 *
 * The contract, in one sentence: **a check always beats the model on the same
 * subject.** If the page title is 90 characters, that is measured, not judged,
 * and re-serving the model's version of the same observation as an "insight"
 * is exactly the thing that makes hybrid tools feel dishonest.
 *
 * Matching happens twice: on the finding id (normalised, because a model will
 * cheerfully write `title_length` for `title-length`), and then on a
 * normalised token comparison of the titles within a single dimension, which
 * catches "Title is too long" against "The page title exceeds recommended
 * length".
 */
import { DIMENSIONS, type Dimension, type Finding, SEVERITIES, type Severity } from './checks.ts'

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0.5,
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const

/** Token overlap above this, inside one dimension, means the same claim. */
const DUPLICATE_THRESHOLD = 0.6

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'if', 'as', 'by',
  'with', 'from', 'than', 'then', 'so', 'it', 'its', 'this', 'that', 'these',
  'those', 'there', 'here', 'has', 'have', 'had', 'do', 'does', 'did', 'not',
  'no', 'too', 'very', 'could', 'would', 'should', 'can', 'may', 'might',
  'will', 'any', 'some', 'all', 'only', 'just', 'also', 'own', 'same', 'into',
  'out', 'up', 'down', 'over', 'under', 'again', 'further', 'page', 'pages',
  'site', 'website', 'your', 'you', 'we', 'our', 'us', 'their', 'they',
])

/**
 * Domain synonyms folded to one token. Deliberately small: this exists so two
 * phrasings of one SEO observation compare equal, not to do general semantics.
 */
const SYNONYMS: Record<string, string> = {
  long: 'length',
  lengthy: 'length',
  length: 'length',
  overlong: 'length',
  exceed: 'length',
  exceeds: 'length',
  truncated: 'length',
  oversized: 'length',
  short: 'short',
  brief: 'short',
  missing: 'missing',
  absent: 'missing',
  lacks: 'missing',
  lacking: 'missing',
  without: 'missing',
  empty: 'missing',
  none: 'missing',
  undefined: 'missing',
  thin: 'thin',
  shallow: 'thin',
  superficial: 'thin',
  sparse: 'thin',
  invalid: 'invalid',
  malformed: 'invalid',
  broken: 'invalid',
  error: 'invalid',
  duplicate: 'duplicate',
  duplicated: 'duplicate',
  repeated: 'duplicate',
  image: 'image',
  img: 'image',
  picture: 'image',
  photo: 'image',
  heading: 'heading',
  headings: 'heading',
  header: 'heading',
  h1: 'heading',
  link: 'link',
  anchor: 'link',
  href: 'link',
  crawl: 'index',
  crawler: 'index',
  crawlable: 'index',
  index: 'index',
  indexing: 'index',
  indexed: 'index',
  indexable: 'index',
}

/**
 * Deduplicates and orders findings. Checks are added first and never displaced;
 * LLM findings survive only when they say something no check already said.
 */
export function mergeFindings(checks: Finding[], llm: Finding[]): Finding[] {
  const kept: Finding[] = []
  const seenIds = new Set<string>()
  const tokensByDimension = new Map<Dimension, Set<string>[]>()

  const consider = (finding: Finding, source: 'check' | 'llm'): void => {
    const clean = sanitise(finding, source)
    if (clean === null) return

    const id = normaliseId(clean.id)
    if (seenIds.has(id)) return

    const tokens = titleTokens(clean.title)
    const siblings = tokensByDimension.get(clean.dimension) ?? []
    if (siblings.some((existing) => isSameClaim(existing, tokens))) return

    seenIds.add(id)
    siblings.push(tokens)
    tokensByDimension.set(clean.dimension, siblings)
    kept.push(clean)
  }

  // Order matters: checks are considered first, so they own their id and their
  // phrasing before the model gets a chance at either.
  for (const finding of checks ?? []) consider(finding, 'check')
  for (const finding of llm ?? []) consider(finding, 'llm')

  return kept.sort(compare)
}

/** A letter grade per dimension. Dimensions with no findings stay at A. */
export function gradeDimensions(findings: Finding[]): Record<Dimension, string> {
  const indices = dimensionIndices(findings)
  const out = {} as Record<Dimension, string>
  for (const dimension of DIMENSIONS) {
    out[dimension] = LETTERS[indices[dimension]] ?? 'F'
  }
  return out
}

/**
 * One grade for the page. Uses the mean across dimensions, but never lets it
 * sit more than one step above the worst dimension — a critical crawlability
 * problem must not average away to an A because the other six are clean.
 */
export function gradeOverall(findings: Finding[]): string {
  const indices = dimensionIndices(findings)
  const values = DIMENSIONS.map((d) => indices[d])
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const worst = Math.max(...values)
  return LETTERS[clampIndex(Math.max(mean, worst - 1))] ?? 'F'
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function dimensionIndices(findings: Finding[]): Record<Dimension, number> {
  const penalties = {} as Record<Dimension, number>
  for (const dimension of DIMENSIONS) penalties[dimension] = 0

  for (const finding of findings ?? []) {
    // A dimension we do not recognise cannot be graded, and inventing a bucket
    // for it would quietly corrupt a real one.
    if (!DIMENSIONS.includes(finding?.dimension)) continue
    penalties[finding.dimension] += SEVERITY_WEIGHT[finding.severity] ?? 0
  }

  const out = {} as Record<Dimension, number>
  for (const dimension of DIMENSIONS) out[dimension] = clampIndex(penalties[dimension])
  return out
}

function clampIndex(value: number): number {
  return Math.max(0, Math.min(LETTERS.length - 1, Math.round(value)))
}

/** Normalises a finding and rejects anything unplaceable. */
function sanitise(finding: Finding, source: 'check' | 'llm'): Finding | null {
  if (!finding || typeof finding.id !== 'string' || finding.id.trim() === '') return null
  if (!DIMENSIONS.includes(finding.dimension)) return null

  const severity: Severity = SEVERITIES.includes(finding.severity) ? finding.severity : 'medium'
  return {
    id: finding.id.trim(),
    // The model does not get to label its own output as a measurement.
    source,
    dimension: finding.dimension,
    severity,
    title: (finding.title ?? '').trim() || finding.id,
    evidence: (finding.evidence ?? '').trim(),
    fix: (finding.fix ?? '').trim(),
    ...(finding.code ? { code: finding.code } : {}),
  }
}

function normaliseId(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function titleTokens(title: string): Set<string> {
  const out = new Set<string>()
  for (const raw of (title ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw === '') continue
    const singular = raw.length > 3 && raw.endsWith('s') && !/(ss|us|is)$/.test(raw)
      ? raw.slice(0, -1)
      : raw
    if (STOPWORDS.has(singular) || STOPWORDS.has(raw)) continue
    out.add(SYNONYMS[singular] ?? SYNONYMS[raw] ?? singular)
  }
  return out
}

/**
 * Overlap coefficient rather than Jaccard: one finding phrased tersely and one
 * phrased at length are still the same claim, and Jaccard punishes the length
 * difference. Below two tokens there is not enough signal, so an exact match
 * is required instead.
 */
function isSameClaim(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false

  let shared = 0
  for (const token of b) if (a.has(token)) shared++

  const smaller = Math.min(a.size, b.size)
  if (smaller < 2) return shared === a.size && a.size === b.size
  return shared / smaller >= DUPLICATE_THRESHOLD
}

function compare(a: Finding, b: Finding): number {
  const bySeverity = SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
  if (bySeverity !== 0) return bySeverity

  const byDimension = DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension)
  if (byDimension !== 0) return byDimension

  // Measured before judged, so the reader meets the facts first.
  if (a.source !== b.source) return a.source === 'check' ? -1 : 1

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
