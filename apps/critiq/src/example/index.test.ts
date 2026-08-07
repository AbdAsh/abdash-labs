import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXAMPLE_ID,
  EXAMPLES,
  exampleDate,
  exampleLabel,
  exampleMarkdownNote,
  exampleSummary,
  findExample,
  readCapture,
} from './index'
import { DIMENSIONS, SEVERITIES } from '../lib/format'
import selfAudit from './self-audit.json'
import jsOnly from './js-only.json'

const editorial = { title: 'T', blurb: 'B' }

/** The provenance block the capture script writes into every fixture. */
interface CaptureBlock {
  mode: string
  endpoint: string
  slug: string
  reviewedAt: string
  capturedAt: string
}

/** A capture file, minus whatever the test wants to break. */
const capture = (over: Record<string, unknown> = {}, report: Record<string, unknown> = {}) => ({
  capture: {
    id: 'demo',
    slug: 'abc123',
    reviewedAt: '2026-08-07T13:19:45.729011+00:00',
    ...over,
  },
  report: {
    slug: 'abc123',
    url: 'https://example.com/',
    status: 'complete',
    grades: { overall: 'B' },
    findings: [],
    digest: { passed: ['title-missing'] },
    created_at: '2026-08-07T13:19:45.729011+00:00',
    ...report,
  },
})

describe('the shipped examples', () => {
  it('ships at least one, and the default resolves to it', () => {
    expect(EXAMPLES.length).toBeGreaterThan(0)
    expect(DEFAULT_EXAMPLE_ID).toBe(EXAMPLES[0]?.id)
    expect(findExample(null)).toBe(EXAMPLES[0])
  })

  it('gives every example a unique id, a title and a blurb', () => {
    const ids = EXAMPLES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const example of EXAMPLES) {
      expect(example.title.trim()).not.toBe('')
      expect(example.blurb.trim()).not.toBe('')
      expect(findExample(example.id)).toBe(example)
    }
  })

  it('carries a real report in each: a graded URL with findings and a digest', () => {
    for (const example of EXAMPLES) {
      expect(example.report.status).toBe('complete')
      expect(example.url).toMatch(/^https?:\/\//)
      expect(example.report.grades.overall).toMatch(/^[A-F]$/)
      expect(example.report.digest).not.toBeNull()
      // Not "some findings" — the point of an example is that the whole UI has
      // something to render, including the list of checks that passed.
      expect(Array.isArray(example.report.digest?.passed)).toBe(true)
    }
  })

  it('only contains findings the report UI knows how to render', () => {
    for (const example of EXAMPLES) {
      for (const finding of example.report.findings) {
        expect(SEVERITIES).toContain(finding.severity)
        expect(DIMENSIONS).toContain(finding.dimension)
        expect(['check', 'llm']).toContain(finding.source)
        expect(finding.title.trim()).not.toBe('')
      }
    }
  })

  it('was captured, not written: the fixtures keep their provenance block', () => {
    for (const file of [selfAudit, jsOnly]) {
      const meta = (file as { capture: CaptureBlock }).capture
      expect(meta.endpoint).toContain('/functions/v1/critiq-review')
      expect(['live', 'adopted']).toContain(meta.mode)
      expect(meta.slug).not.toBe('')
      expect(Number.isNaN(new Date(meta.reviewedAt).getTime())).toBe(false)
    }
  })

  it('keeps the review date the fixture recorded, not the file write date', () => {
    // `capturedAt` moves every time the script runs; `reviewedAt` is when the
    // function actually graded the page, and that is what gets shown.
    for (const [file, example] of [[selfAudit, EXAMPLES[0]], [jsOnly, EXAMPLES[1]]] as const) {
      const meta = (file as { capture: CaptureBlock }).capture
      expect(example?.reviewedAt).toBe(meta.reviewedAt)
      expect(example?.report.created_at).toBe(meta.reviewedAt)
    }
  })

  it('still demonstrates the js-only critical finding', () => {
    // The argument the SPA example exists to make. If a recapture ever loses
    // it, the example is no longer worth its place and this should say so.
    const spa = findExample('js-only')
    const jsOnlyFinding = spa?.report.findings.find((f) => f.id === 'js-only-content')
    expect(jsOnlyFinding?.severity).toBe('critical')
    expect(jsOnlyFinding?.source).toBe('check')
  })
})

describe('exampleLabel', () => {
  it('names the URL and the date, and says nothing was run', () => {
    const example = readCapture(capture(), editorial)
    const label = exampleLabel(example)
    expect(label).toContain('Saved example')
    expect(label).toContain('https://example.com/')
    expect(label).toContain('7 August 2026')
    expect(label).toMatch(/Nothing was fetched or graded/)
  })

  it('labels every shipped example with its own URL and date', () => {
    for (const example of EXAMPLES) {
      const label = exampleLabel(example)
      expect(label).toContain(example.url)
      expect(label).toContain(exampleDate(example.reviewedAt))
    }
  })
})

describe('exampleMarkdownNote', () => {
  it('travels with a copied report, because the on-screen label does not', () => {
    const note = exampleMarkdownNote(readCapture(capture(), editorial))
    expect(note).toContain('Saved example')
    expect(note).toContain('https://example.com/')
    expect(note).toContain('7 August 2026')
    expect(note).toContain('Not a live review.')
  })
})

describe('exampleDate', () => {
  it('spells the month out in UTC, so the date cannot shift or be misread', () => {
    expect(exampleDate('2026-08-07T13:19:45.729011+00:00')).toBe('7 August 2026')
    // Late UTC, which is the next day in Sydney and the same day in London.
    expect(exampleDate('2026-01-31T23:59:00Z')).toBe('31 January 2026')
  })

  it('says so rather than printing Invalid Date', () => {
    expect(exampleDate('not a date')).toBe('an unrecorded date')
  })
})

describe('exampleSummary', () => {
  it('counts the report rather than repeating a hand-written claim', () => {
    const example = readCapture(
      capture({}, {
        grades: { overall: 'C' },
        findings: [{ id: 'x', source: 'llm', dimension: 'content', severity: 'low', title: 't', evidence: '', fix: '' }],
        digest: { passed: ['a', 'b', 'c'] },
      }),
      editorial,
    )
    expect(exampleSummary(example)).toBe('C overall · 1 finding · 3 checks passed')
  })

  it('drops the passed count rather than claiming zero checks ran', () => {
    const example = readCapture(capture({}, { digest: {} }), editorial)
    expect(exampleSummary(example)).toBe('B overall · 0 findings')
  })

  it('matches the shipped fixtures', () => {
    expect(exampleSummary(EXAMPLES[0]!)).toBe('B overall · 4 findings · 23 checks passed')
  })
})

describe('readCapture', () => {
  it('takes the URL, grades and findings straight from the captured report', () => {
    const example = readCapture(capture(), editorial)
    expect(example.id).toBe('demo')
    expect(example.slug).toBe('abc123')
    expect(example.url).toBe('https://example.com/')
    expect(example.report.grades.overall).toBe('B')
  })

  // Every one of these ends with a page that claims to be a real report and is
  // not, so none of them is allowed to degrade quietly.
  it.each([
    ['no id', capture({ id: '' })],
    ['no slug', capture({ slug: '' })],
    ['no review date', capture({ reviewedAt: '' })],
    ['an unparseable review date', capture({ reviewedAt: 'yesterday' })],
    ['no URL', capture({}, { url: '' })],
    ['no overall grade', capture({}, { grades: {} })],
    ['no findings array', capture({}, { findings: undefined })],
  ])('refuses a capture with %s', (_why, broken) => {
    expect(() => readCapture(broken, editorial)).toThrow()
  })

  it('refuses a file with no report at all', () => {
    expect(() => readCapture({ capture: { id: 'demo' } }, editorial)).toThrow(/no report/)
  })
})
