import { describe, expect, it } from 'vitest'
import {
  countBySeverity,
  displayUrl,
  filterBySeverity,
  gradeTone,
  groupByDimension,
  normaliseUrlInput,
  quotaLabel,
} from './format'
import { BASE, parseRoute, reportPath } from './router'
import type { Finding } from './types'

const f = (over: Partial<Finding> & { id: string }): Finding => ({
  source: 'check',
  dimension: 'metadata',
  severity: 'medium',
  title: over.id,
  evidence: '',
  fix: '',
  ...over,
})

describe('parseRoute', () => {
  it('routes the app root to the submit form', () => {
    expect(parseRoute('/critiq/')).toEqual({ name: 'submit' })
    expect(parseRoute('/critiq')).toEqual({ name: 'submit' })
  })

  it('routes a permalink to the report', () => {
    expect(parseRoute('/critiq/r/abc123')).toEqual({ name: 'report', slug: 'abc123' })
  })

  it('decodes a percent-encoded slug and survives a broken one', () => {
    expect(parseRoute('/critiq/r/a%20b')).toEqual({ name: 'report', slug: 'a b' })
    expect(parseRoute('/critiq/r/%E0%A4%A')).toEqual({ name: 'report', slug: '%E0%A4%A' })
  })

  it('falls back to submit for anything unrecognised', () => {
    expect(parseRoute('/critiq/r/')).toEqual({ name: 'submit' })
    expect(parseRoute('/critiq/nonsense')).toEqual({ name: 'submit' })
  })

  it('round-trips a slug through reportPath', () => {
    expect(parseRoute(reportPath('a b/c'))).toEqual({ name: 'report', slug: 'a b/c' })
  })

  it('keeps every path under the app prefix, so sibling apps are never captured', () => {
    expect(reportPath('x').startsWith(`${BASE}/`)).toBe(true)
  })
})

describe('gradeTone', () => {
  it('bands letters into good, fair and poor', () => {
    expect(gradeTone('A')).toBe('good')
    expect(gradeTone('B')).toBe('good')
    expect(gradeTone('C')).toBe('fair')
    expect(gradeTone('D')).toBe('fair')
    expect(gradeTone('E')).toBe('poor')
    expect(gradeTone('F')).toBe('poor')
  })

  it('treats an unknown or absent grade as poor rather than good', () => {
    expect(gradeTone(undefined)).toBe('poor')
    expect(gradeTone('')).toBe('poor')
    expect(gradeTone('?')).toBe('poor')
  })
})

describe('severity handling', () => {
  const findings = [
    f({ id: 'a', severity: 'critical' }),
    f({ id: 'b', severity: 'high' }),
    f({ id: 'c', severity: 'high' }),
    f({ id: 'd', severity: 'low' }),
  ]

  it('counts each severity', () => {
    expect(countBySeverity(findings)).toEqual({ critical: 1, high: 2, medium: 0, low: 1 })
  })

  it('ignores a severity the server should never have sent', () => {
    const counts = countBySeverity([...findings, f({ id: 'x', severity: 'urgent' as never })])
    expect(counts).toEqual({ critical: 1, high: 2, medium: 0, low: 1 })
  })

  it('filters, with "all" meaning no filter', () => {
    expect(filterBySeverity(findings, 'high').map((x) => x.id)).toEqual(['b', 'c'])
    expect(filterBySeverity(findings, 'all')).toHaveLength(4)
    expect(filterBySeverity(findings, 'medium')).toEqual([])
  })
})

describe('groupByDimension', () => {
  it('returns dimensions in the documented order and omits empty ones', () => {
    const groups = groupByDimension([
      f({ id: 'a', dimension: 'answer-engine' }),
      f({ id: 'b', dimension: 'crawlability' }),
      f({ id: 'c', dimension: 'answer-engine' }),
    ])
    expect(groups.map((g) => g.dimension)).toEqual(['crawlability', 'answer-engine'])
    expect(groups[1]?.findings.map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('returns nothing for a clean page', () => {
    expect(groupByDimension([])).toEqual([])
  })
})

describe('normaliseUrlInput', () => {
  it('assumes https for a bare host', () => {
    expect(normaliseUrlInput('abdash.net')).toBe('https://abdash.net')
    expect(normaliseUrlInput('  abdash.net/blog  ')).toBe('https://abdash.net/blog')
  })

  it('leaves an explicit scheme alone, including one the guard will reject', () => {
    expect(normaliseUrlInput('http://abdash.net')).toBe('http://abdash.net')
    expect(normaliseUrlInput('file:///etc/passwd')).toBe('file:///etc/passwd')
  })

  it('returns empty for empty', () => {
    expect(normaliseUrlInput('   ')).toBe('')
  })
})

describe('display helpers', () => {
  it('shortens a URL without hiding the page', () => {
    expect(displayUrl('https://example.com/blog/')).toBe('example.com/blog')
    expect(displayUrl(`https://example.com/${'x'.repeat(100)}`, 20)).toHaveLength(20)
  })

  it('states the remaining quota honestly', () => {
    expect(quotaLabel(0, 1)).toBe('1 of 1 review left today')
    expect(quotaLabel(1, 1)).toBe('0 of 1 review left today')
    expect(quotaLabel(1, 3)).toBe('2 of 3 reviews left today')
    expect(quotaLabel(5, 3)).toBe('0 of 3 reviews left today')
    expect(quotaLabel(0, 0)).toBe('Daily limit unavailable')
  })
})
