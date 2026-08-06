import { describe, expect, it } from 'vitest'
import {
  countByDimension,
  countBySeverity,
  displayUrl,
  elapsedLabel,
  emptyFilterLabel,
  filterFindings,
  gradeTone,
  groupByDimension,
  isFiltered,
  NO_FILTER,
  normalizeUrlInput,
  quotaLabel,
  REVIEW_STAGES,
  sourceSplit,
  stageAt,
  summarise,
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
    const bySeverity = (severity: Finding['severity'] | 'all') =>
      filterFindings(findings, { severity, dimension: 'all' })
    expect(bySeverity('high').map((x) => x.id)).toEqual(['b', 'c'])
    expect(bySeverity('all')).toHaveLength(4)
    expect(bySeverity('medium')).toEqual([])
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

describe('normalizeUrlInput', () => {
  it('assumes https for a bare host', () => {
    expect(normalizeUrlInput('abdash.net')).toBe('https://abdash.net')
    expect(normalizeUrlInput('  abdash.net/blog  ')).toBe('https://abdash.net/blog')
  })

  it('leaves an explicit scheme alone, including one the guard will reject', () => {
    expect(normalizeUrlInput('http://abdash.net')).toBe('http://abdash.net')
    expect(normalizeUrlInput('file:///etc/passwd')).toBe('file:///etc/passwd')
  })

  it('returns empty for empty', () => {
    expect(normalizeUrlInput('   ')).toBe('')
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

describe('filtering on both axes', () => {
  const findings = [
    f({ id: 'a', severity: 'critical', dimension: 'crawlability' }),
    f({ id: 'b', severity: 'high', dimension: 'crawlability' }),
    f({ id: 'c', severity: 'high', dimension: 'links' }),
    f({ id: 'd', severity: 'low', dimension: 'links' }),
  ]

  it('counts findings per dimension, including the empty ones', () => {
    const counts = countByDimension(findings)
    expect(counts.crawlability).toBe(2)
    expect(counts.links).toBe(2)
    expect(counts.metadata).toBe(0)
    expect(Object.keys(counts)).toHaveLength(7)
  })

  it('applies severity and dimension together', () => {
    expect(filterFindings(findings, NO_FILTER)).toHaveLength(4)
    expect(filterFindings(findings, { severity: 'high', dimension: 'all' }).map((x) => x.id))
      .toEqual(['b', 'c'])
    expect(filterFindings(findings, { severity: 'all', dimension: 'links' }).map((x) => x.id))
      .toEqual(['c', 'd'])
    expect(filterFindings(findings, { severity: 'high', dimension: 'links' }).map((x) => x.id))
      .toEqual(['c'])
    expect(filterFindings(findings, { severity: 'critical', dimension: 'links' })).toEqual([])
  })

  it('knows whether a filter is doing anything', () => {
    expect(isFiltered(NO_FILTER)).toBe(false)
    expect(isFiltered({ severity: 'low', dimension: 'all' })).toBe(true)
    expect(isFiltered({ severity: 'all', dimension: 'links' })).toBe(true)
  })

  it('names the filter that emptied the list, so the reader knows what to undo', () => {
    expect(emptyFilterLabel({ severity: 'critical', dimension: 'all' }))
      .toBe('No critical findings.')
    expect(emptyFilterLabel({ severity: 'all', dimension: 'links' }))
      .toBe('No findings in Links.')
    expect(emptyFilterLabel({ severity: 'high', dimension: 'answer-engine' }))
      .toBe('No high findings in Answer-engine readiness.')
  })
})

describe('summarise', () => {
  it('leads with the worst severity present', () => {
    expect(summarise([f({ id: 'a', severity: 'critical' }), f({ id: 'b', severity: 'low' })]))
      .toBe('1 critical finding, and 1 less urgent.')
    expect(summarise([f({ id: 'a', severity: 'high' }), f({ id: 'b', severity: 'high' })]))
      .toBe('2 high findings.')
  })

  it('says nothing is wrong when nothing is', () => {
    expect(summarise([])).toBe('No problems found.')
  })

  it('does not crash on a severity the server should never have sent', () => {
    expect(summarise([f({ id: 'x', severity: 'urgent' as never })])).toBe('1 finding.')
  })
})

describe('sourceSplit', () => {
  it('separates what was measured from what was judged', () => {
    expect(sourceSplit([
      f({ id: 'a' }),
      f({ id: 'b', source: 'llm' }),
      f({ id: 'c', source: 'llm' }),
    ])).toEqual({ measured: 1, judged: 2 })
    expect(sourceSplit([])).toEqual({ measured: 0, judged: 0 })
  })
})

describe('progress', () => {
  it('advances through the stages in order as time passes', () => {
    expect(stageAt(0).label).toBe(REVIEW_STAGES[0]?.label)
    expect(stageAt(3000).label).toBe(REVIEW_STAGES[1]?.label)
    expect(stageAt(5000).label).toBe(REVIEW_STAGES[2]?.label)
    expect(stageAt(10_000).label).toBe(REVIEW_STAGES[3]?.label)
  })

  it('never runs past the last stage, however long the wait', () => {
    const last = REVIEW_STAGES[REVIEW_STAGES.length - 1]
    expect(stageAt(60_000).label).toBe(last?.label)
    expect(stageAt(Number.MAX_SAFE_INTEGER).label).toBe(last?.label)
  })

  it('holds at the first stage for a negative or zero clock', () => {
    expect(stageAt(-1).label).toBe(REVIEW_STAGES[0]?.label)
  })

  it('is declared in ascending order, or stageAt would skip a stage', () => {
    for (let i = 1; i < REVIEW_STAGES.length; i++) {
      expect(REVIEW_STAGES[i]!.at).toBeGreaterThan(REVIEW_STAGES[i - 1]!.at)
    }
  })

  it('shows whole seconds', () => {
    expect(elapsedLabel(0)).toBe('0s')
    expect(elapsedLabel(1999)).toBe('1s')
    expect(elapsedLabel(-50)).toBe('0s')
  })
})
