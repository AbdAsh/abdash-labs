import { describe, expect, it } from 'vitest'
import {
  findingToMarkdown,
  readPassed,
  reportToMarkdown,
  storedReportToMarkdown,
} from './markdown'
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

describe('findingToMarkdown', () => {
  it('carries severity, dimension, source and id', () => {
    const md = findingToMarkdown(f({
      id: 'title-length',
      severity: 'high',
      title: 'The title is 90 characters',
    }))
    expect(md).toContain('### The title is 90 characters')
    expect(md).toContain('**Severity:** high')
    expect(md).toContain('Metadata & SERP presentation')
    expect(md).toContain('measured')
    expect(md).toContain('`title-length`')
  })

  it('labels a model finding as judged', () => {
    expect(findingToMarkdown(f({ id: 'intent-mismatch', source: 'llm' }))).toContain('judged')
  })

  it('omits blocks that have nothing in them', () => {
    const md = findingToMarkdown(f({ id: 'x' }))
    expect(md).not.toContain('**Evidence**')
    expect(md).not.toContain('**Fix**')
    expect(md).not.toContain('**Suggested markup**')
  })

  it('fences evidence and markup so they survive a paste', () => {
    const md = findingToMarkdown(f({
      id: 'img-alt-missing',
      evidence: '<img src="a.png">',
      fix: 'Describe the image.',
      code: '<img src="a.png" alt="A loaf">',
    }))
    expect(md).toContain('```\n<img src="a.png">\n```')
    expect(md).toContain('```html\n<img src="a.png" alt="A loaf">\n```')
  })

  it('widens the fence past backticks inside the evidence', () => {
    // Evidence is quoted from someone else's page. A bare ``` fence would end
    // early and spill the rest of the markup into the surrounding prose.
    const md = findingToMarkdown(f({ id: 'x', evidence: 'here is ``` a fence' }))
    expect(md).toContain('````\nhere is ``` a fence\n````')
  })
})

describe('reportToMarkdown', () => {
  const findings = [
    f({ id: 'noindex-present', dimension: 'crawlability', severity: 'critical', title: 'Noindex' }),
    f({ id: 'title-length', severity: 'medium', title: 'Title too long' }),
  ]

  it('leads with the URL, the overall grade and the count', () => {
    const md = reportToMarkdown({
      url: 'https://example.com/page',
      grades: { overall: 'D', crawlability: 'D', metadata: 'B' },
      findings,
    })
    expect(md).toContain('# Critiq review — https://example.com/page')
    expect(md).toContain('**Overall grade: D**')
    expect(md).toContain('2 findings')
  })

  it('renders the per-dimension grades as a table, without the overall row', () => {
    const md = reportToMarkdown({
      url: 'https://example.com/',
      grades: { overall: 'C', crawlability: 'D' },
      findings: [],
    })
    expect(md).toContain('| Dimension | Grade |')
    expect(md).toContain('| Crawlability & indexing | D |')
    expect(md).not.toContain('| overall |')
  })

  it('says so plainly when there is nothing to report', () => {
    const md = reportToMarkdown({ url: 'https://example.com/', grades: { overall: 'A' }, findings: [] })
    expect(md).toContain('No findings.')
    expect(md).toContain('0 findings')
  })

  it('lists the verified checks, so a clean report is not an empty document', () => {
    const md = reportToMarkdown({
      url: 'https://example.com/',
      grades: { overall: 'A' },
      findings: [],
      passed: ['title-missing', 'lang-missing'],
    })
    expect(md).toContain('## Verified (2)')
    expect(md).toContain('- The page has a title')
  })

  it('survives a report with no grades at all', () => {
    const md = reportToMarkdown({ url: 'https://example.com/', grades: null, findings: [] })
    expect(md).toContain('**Overall grade: ?**')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('quotes a provenance note above the grade table, so a paste keeps its label', () => {
    // A saved example copied into a ticket has left the page carrying the
    // on-screen label. Without this, the paste reads as a live review.
    const md = reportToMarkdown({
      url: 'https://example.com/',
      grades: { overall: 'B', metadata: 'A' },
      findings: [],
      note: 'Saved example: captured 7 August 2026. Not a live review.',
    })
    expect(md).toContain('> Saved example: captured 7 August 2026. Not a live review.')
    expect(md.indexOf('Saved example')).toBeLessThan(md.indexOf('| Dimension | Grade |'))
  })

  it('adds nothing when there is no note', () => {
    const plain = reportToMarkdown({ url: 'https://example.com/', grades: null, findings: [] })
    const blank = reportToMarkdown({
      url: 'https://example.com/',
      grades: null,
      findings: [],
      note: '   ',
    })
    expect(blank).toBe(plain)
    expect(plain).not.toContain('>')
  })
})

describe('storedReportToMarkdown', () => {
  const stored = {
    slug: 'abc123',
    url: 'https://example.com/',
    status: 'complete',
    grades: { overall: 'B' },
    findings: [f({ id: 'title-length' })],
    digest: { passed: ['lang-missing'] },
    created_at: '2026-08-07T13:19:45Z',
  }

  it('pulls the passed ids out of the digest', () => {
    expect(storedReportToMarkdown(stored)).toContain('- The page declares its language')
  })

  it('carries the note through to the document', () => {
    expect(storedReportToMarkdown(stored, '7 Aug 2026', 'Saved example.')).toContain(
      '> Saved example.',
    )
  })
})

describe('readPassed', () => {
  it('reads the ids the function stored beside the digest', () => {
    expect(readPassed({ passed: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('treats a digest from before the field existed as no coverage claim', () => {
    expect(readPassed({})).toEqual([])
    expect(readPassed(null)).toEqual([])
    expect(readPassed(undefined)).toEqual([])
  })

  it('discards anything that is not a string id', () => {
    expect(readPassed({ passed: ['a', 3, null, { x: 1 }] })).toEqual(['a'])
    expect(readPassed({ passed: 'not-an-array' })).toEqual([])
  })
})
