import type { Dimension, Finding, Severity } from './types'

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

export const DIMENSIONS: Dimension[] = [
  'crawlability',
  'metadata',
  'content',
  'structure',
  'links',
  'structured-data',
  'answer-engine',
]

export const DIMENSION_LABELS: Record<Dimension, string> = {
  'crawlability': 'Crawlability & indexing',
  'metadata': 'Metadata & SERP presentation',
  'content': 'Content & intent',
  'structure': 'Structure & semantics',
  'links': 'Links',
  'structured-data': 'Structured data',
  'answer-engine': 'Answer-engine readiness',
}

export const SOURCE_LABELS: Record<Finding['source'], string> = {
  check: 'measured',
  llm: 'judged',
}

/**
 * Maps a letter to a colour band. Deliberately three bands rather than six:
 * the useful question is "is this fine, is it worth a look, or is it broken".
 */
export function gradeTone(grade: string | undefined): 'good' | 'fair' | 'poor' {
  switch ((grade ?? '').trim().toUpperCase()) {
    case 'A':
    case 'B':
      return 'good'
    case 'C':
    case 'D':
      return 'fair'
    default:
      return 'poor'
  }
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const finding of findings ?? []) {
    if (SEVERITIES.includes(finding.severity)) counts[finding.severity]++
  }
  return counts
}

export function countByDimension(findings: Finding[]): Record<Dimension, number> {
  const counts = {} as Record<Dimension, number>
  for (const dimension of DIMENSIONS) counts[dimension] = 0
  for (const finding of findings ?? []) {
    if (DIMENSIONS.includes(finding.dimension)) counts[finding.dimension]++
  }
  return counts
}

export interface FindingFilter {
  severity: Severity | 'all'
  dimension: Dimension | 'all'
}

export const NO_FILTER: FindingFilter = { severity: 'all', dimension: 'all' }

/** Both axes at once. Severity answers "how bad", dimension answers "about what". */
export function filterFindings(findings: Finding[], filter: FindingFilter): Finding[] {
  return (findings ?? []).filter((f) =>
    (filter.severity === 'all' || f.severity === filter.severity) &&
    (filter.dimension === 'all' || f.dimension === filter.dimension)
  )
}

export function isFiltered(filter: FindingFilter): boolean {
  return filter.severity !== 'all' || filter.dimension !== 'all'
}

/** "No critical findings in Links" — says which filter emptied the list. */
export function emptyFilterLabel(filter: FindingFilter): string {
  const severity = filter.severity === 'all' ? 'findings' : `${filter.severity} findings`
  const where = filter.dimension === 'all' ? '' : ` in ${DIMENSION_LABELS[filter.dimension]}`
  return `No ${severity}${where}.`
}

/**
 * The one sentence at the top of a report.
 *
 * Leads with the worst thing, because that is what the reader needs first and
 * what a shared link should convey before anyone scrolls.
 */
export function summarise(findings: Finding[]): string {
  const list = findings ?? []
  if (list.length === 0) return 'No problems found.'

  const counts = countBySeverity(list)
  const worst = SEVERITIES.find((s) => counts[s] > 0)
  if (!worst) return `${list.length} finding${list.length === 1 ? '' : 's'}.`

  const rest = list.length - counts[worst]
  const lead = `${counts[worst]} ${worst} finding${counts[worst] === 1 ? '' : 's'}`
  return rest === 0 ? `${lead}.` : `${lead}, and ${rest} less urgent.`
}

/**
 * How much of this report the model is responsible for.
 *
 * The whole claim of the tool is that mechanics are measured and only judgment
 * is generated, so the split belongs on the page rather than in the README.
 */
export function sourceSplit(findings: Finding[]): { measured: number; judged: number } {
  let measured = 0
  let judged = 0
  for (const finding of findings ?? []) {
    if (finding.source === 'llm') judged++
    else measured++
  }
  return { measured, judged }
}

/** Groups into dimension order, dropping dimensions with nothing to say. */
export function groupByDimension(findings: Finding[]): { dimension: Dimension; findings: Finding[] }[] {
  return DIMENSIONS
    .map((dimension) => ({
      dimension,
      findings: (findings ?? []).filter((f) => f.dimension === dimension),
    }))
    .filter((group) => group.findings.length > 0)
}

/**
 * What someone types is rarely a URL. A bare host is the common case, and
 * rejecting it teaches nothing — assume https and let the server's SSRF guard
 * be the authority on whether the result is acceptable.
 */
export function normalizeUrlInput(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed // let a bad scheme reach the guard
  return `https://${trimmed}`
}

/** Shortens a URL for display without hiding which page it is. */
export function displayUrl(url: string, max = 60): string {
  const stripped = (url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return stripped.length <= max ? stripped : `${stripped.slice(0, max - 1)}…`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "1 of 3 reviews left today", or the honest zero. */
export function quotaLabel(used: number, limit: number): string {
  if (limit <= 0) return 'Daily limit unavailable'
  const left = Math.max(0, limit - used)
  return `${left} of ${limit} review${limit === 1 ? '' : 's'} left today`
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface Stage {
  /** Milliseconds after submission at which this stage becomes the current one. */
  at: number
  label: string
}

/**
 * A review is one HTTP request, so the client cannot observe which phase the
 * server is in. These are the real phases in the real order, advertised as
 * typical timings and labelled as such on the page — the alternative is a
 * progress bar that claims knowledge it does not have, which is the kind of
 * polish that quietly teaches people the tool lies.
 */
export const REVIEW_STAGES: Stage[] = [
  { at: 0, label: 'Fetching the page' },
  { at: 2500, label: 'Reading robots.txt and the sitemap' },
  { at: 4500, label: 'Parsing the HTML and running 23 checks' },
  { at: 6500, label: 'Asking the model for judgment' },
  { at: 20000, label: 'Still waiting on the model' },
]

export function stageAt(elapsedMs: number): Stage {
  let current = REVIEW_STAGES[0] as Stage
  for (const stage of REVIEW_STAGES) {
    if (elapsedMs >= stage.at) current = stage
  }
  return current
}

/** "4s" — whole seconds, because tenths on a 15-second wait are just noise. */
export function elapsedLabel(elapsedMs: number): string {
  return `${Math.max(0, Math.floor(elapsedMs / 1000))}s`
}
