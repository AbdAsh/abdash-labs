import { describe, expect, it } from 'vitest'
import {
  classifyEvidence,
  evidenceAddsSomething,
  lineKind,
  tokenizeMarkup,
} from './evidence'

const text = (tokens: { text: string }[]) => tokens.map((t) => t.text).join('')

describe('lineKind', () => {
  it('recognises markup', () => {
    expect(lineKind('<img src="a.png">')).toBe('markup')
    expect(lineKind('  <h1>Hello</h1>')).toBe('markup')
    expect(lineKind('</div>')).toBe('markup')
    expect(lineKind('<!doctype html>')).toBe('markup')
  })

  it('recognises measured chains, URLs and JSON as code', () => {
    expect(lineKind('https://example.com/a')).toBe('code')
    expect(lineKind('  → https://example.com/b')).toBe('code')
    expect(lineKind('"click here" → https://example.com/x')).toBe('code')
    expect(lineKind('{"@type":"Article"')).toBe('code')
    expect(lineKind('[{"broken": ')).toBe('code')
  })

  it('treats a sentence about a measurement as prose', () => {
    // Rendering this in a code box is what the split exists to stop.
    expect(lineKind('65 characters (aim for 25–65): "How to bake sourdough"')).toBe('text')
    expect(lineKind('meta name="robots": noindex')).toBe('text')
    expect(lineKind('The page has no headings at all')).toBe('text')
  })

  it('does not mistake a less-than in prose for a tag', () => {
    expect(lineKind('word count < 300 on this page')).toBe('text')
  })
})

describe('classifyEvidence', () => {
  it('groups consecutive lines of the same kind into one run', () => {
    const runs = classifyEvidence('<h1>A</h1>\n<h1>B</h1>')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.kind).toBe('markup')
    expect(runs[0]?.lines).toEqual(['<h1>A</h1>', '<h1>B</h1>'])
  })

  it('keeps a mixed block in order, split by kind', () => {
    const runs = classifyEvidence(
      'The chain resolved through three hops:\nhttps://a.test/\n  → https://b.test/',
    )
    expect(runs.map((r) => r.kind)).toEqual(['text', 'code'])
    expect(runs[1]?.lines).toHaveLength(2)
  })

  it('drops blank lines rather than splitting a block around them', () => {
    const runs = classifyEvidence('<img src="a">\n\n<img src="b">')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.lines).toHaveLength(2)
  })

  it('returns nothing for nothing', () => {
    expect(classifyEvidence('')).toEqual([])
    expect(classifyEvidence(null)).toEqual([])
    expect(classifyEvidence(undefined)).toEqual([])
    expect(classifyEvidence('   \n  \n')).toEqual([])
  })
})

describe('tokenizeMarkup', () => {
  it('never loses or invents a character', () => {
    // The whole safety property: what goes in is what gets rendered.
    for (
      const line of [
        '<img src="hero.png" alt="">',
        '<a href=\'/x\' rel="nofollow">click here</a>',
        '<meta name=viewport content=width=device-width>',
        'plain text with no tags at all',
        '<broken',
        'a < b and c > d',
        '<!-- a comment -->',
        '<link rel="canonical" href="https://example.com/page?a=1&b=2">',
      ]
    ) {
      expect(text(tokenizeMarkup(line))).toBe(line)
    }
  })

  it('separates the tag name, attribute names and values', () => {
    const tokens = tokenizeMarkup('<img src="hero.png" alt="A loaf">')
    expect(tokens.filter((t) => t.type === 'tag').map((t) => t.text)).toEqual(['img'])
    expect(tokens.filter((t) => t.type === 'attr').map((t) => t.text)).toEqual(['src', 'alt'])
    expect(tokens.filter((t) => t.type === 'value').map((t) => t.text))
      .toEqual(['"hero.png"', '"A loaf"'])
  })

  it('marks text between tags as text, not as markup', () => {
    const tokens = tokenizeMarkup('<h1>How to bake bread</h1>')
    expect(tokens.filter((t) => t.type === 'text').map((t) => t.text))
      .toEqual(['How to bake bread'])
  })

  it('handles a closing tag and a self-closing tag', () => {
    expect(tokenizeMarkup('</div>').filter((t) => t.type === 'tag')[0]?.text).toBe('div')
    expect(text(tokenizeMarkup('<br />'))).toBe('<br />')
  })

  it('emits no empty tokens', () => {
    for (const token of tokenizeMarkup('<a href="" rel="">x</a>')) {
      expect(token.text).not.toBe('')
    }
  })

  it('survives an attacker-shaped string without throwing', () => {
    // Evidence is quoted from a page a stranger asked us to fetch.
    const nasty = '<script>alert("</script>")</script><<>>&amp;'
    expect(text(tokenizeMarkup(nasty))).toBe(nasty)
  })
})

describe('evidenceAddsSomething', () => {
  it('hides evidence that only restates the title', () => {
    expect(evidenceAddsSomething('No H1 heading', 'No H1 heading')).toBe(false)
    expect(evidenceAddsSomething('  no h1 heading!  ', 'No H1 heading')).toBe(false)
  })

  it('keeps evidence that carries something the title does not', () => {
    expect(evidenceAddsSomething('<h1>A</h1>', 'The page has 2 H1 headings')).toBe(true)
  })

  it('hides empty evidence', () => {
    expect(evidenceAddsSomething('', 'anything')).toBe(false)
    expect(evidenceAddsSomething(null, 'anything')).toBe(false)
  })
})
