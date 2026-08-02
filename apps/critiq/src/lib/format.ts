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

export function filterBySeverity(findings: Finding[], severity: Severity | 'all'): Finding[] {
  if (severity === 'all') return findings ?? []
  return (findings ?? []).filter((f) => f.severity === severity)
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
export function normaliseUrlInput(raw: string): string {
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
