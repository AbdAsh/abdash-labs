import { describe, expect, it } from 'vitest'
import { headingOutline, measurements } from './digest'

const flatten = (groups: ReturnType<typeof measurements>) =>
  Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.label, r.value])))

describe('measurements', () => {
  it('reports the facts a reader needs to confirm the right page was reviewed', () => {
    const rows = flatten(measurements({
      status: 200,
      finalUrl: 'https://example.com/page',
      contentType: 'text/html',
      elapsedMs: 210,
      title: 'How to bake sourdough',
      description: 'A guide.',
      wordCount: 1400,
      textHtmlRatio: 0.2812,
      lang: 'en',
    }))
    expect(rows.Status).toBe('200')
    expect(rows['Final URL']).toBe('https://example.com/page')
    expect(rows['Fetched in']).toBe('210 ms')
    expect(rows['Title (21 chars)']).toBe('How to bake sourdough')
    expect(rows.Words).toBe('1400')
    expect(rows['Text-to-HTML']).toBe('28.1%')
  })

  it('omits a field the digest does not have rather than printing undefined', () => {
    const rows = flatten(measurements({ status: 200 }))
    expect(rows.Status).toBe('200')
    expect('Canonical' in rows).toBe(false)
    expect('Words' in rows).toBe(false)
  })

  it('survives a null digest and a digest full of the wrong types', () => {
    expect(measurements(null)).toEqual([])
    expect(measurements(undefined)).toEqual([])
    expect(() =>
      measurements({
        status: 'two hundred',
        headings: 'not an array',
        images: 42,
        og: [],
        jsonLd: null,
        wordCount: Number.NaN,
      })
    ).not.toThrow()
  })

  it('says plainly when the body was cut off, because every count below is a floor', () => {
    const rows = flatten(measurements({ truncated: true, htmlLength: 2097152 }))
    expect(rows.Read).toMatch(/size cap/i)
    expect(rows['Response size']).toBe('2.00 MB')
  })

  it('distinguishes described, decorative and missing alt text', () => {
    const rows = flatten(measurements({
      images: [
        { src: 'a', alt: 'A loaf' },
        { src: 'b', alt: '' },
        { src: 'c', alt: null },
        { src: 'd' },
      ],
    }))
    expect(rows.Images).toBe(
      '4 total — 1 described, 1 marked decorative, 2 with no alt attribute',
    )
  })

  it('summarises headings by level', () => {
    const rows = flatten(measurements({
      headings: [
        { level: 1, text: 'a' },
        { level: 2, text: 'b' },
        { level: 2, text: 'c' },
      ],
    }))
    expect(rows.Headings).toBe('1×h1, 2×h2')
  })

  it('names the schema types found, and flags blocks that do not parse', () => {
    expect(flatten(measurements({ jsonLd: [] }))['JSON-LD types']).toBe('none')
    expect(flatten(measurements({ jsonLd: [{ valid: true, types: ['Article'] }] }))['JSON-LD types'])
      .toBe('Article')
    expect(
      flatten(measurements({
        jsonLd: [{ valid: true, types: ['Article'] }, { valid: false, types: [] }],
      }))['JSON-LD types'],
    ).toBe('Article (1 block(s) do not parse)')
  })

  it('reports whether the sidecars were readable, distinctly from being absent', () => {
    const unread = flatten(measurements({ robotsFound: false, sitemapFound: false }))
    expect(unread['robots.txt']).toBe('not readable')
    expect(unread.Sitemap).toBe('not found')
    expect('robots.txt' in flatten(measurements({}))).toBe(false)
  })

  it('drops a group with nothing in it', () => {
    expect(measurements({}).map((g) => g.title)).toEqual([])
  })
})

describe('headingOutline', () => {
  it('keeps document order and level', () => {
    const outline = headingOutline({
      headings: [{ level: 1, text: 'Top' }, { level: 3, text: 'Deep' }],
    })
    expect(outline).toEqual([{ level: 1, text: 'Top' }, { level: 3, text: 'Deep' }])
  })

  it('caps the list, because some pages have hundreds', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ level: 2, text: `h${i}` }))
    expect(headingOutline({ headings: many })).toHaveLength(40)
    expect(headingOutline({ headings: many }, 5)).toHaveLength(5)
  })

  it('labels an empty heading rather than rendering a blank row', () => {
    expect(headingOutline({ headings: [{ level: 2, text: '' }] })[0]?.text).toBe('(empty heading)')
  })

  it('skips entries with no level and survives rubbish', () => {
    expect(headingOutline({ headings: [{ text: 'no level' }, null, 'x', { level: 2, text: 'ok' }] }))
      .toEqual([{ level: 2, text: 'ok' }])
    expect(headingOutline(null)).toEqual([])
  })
})
