import { describe, it, expect } from 'vitest'
import { nameAppearsIn, normalizeName, normalizeQuote, validateExtraction } from './validate'

const text = 'Dr. Sarah Chen founded Helix Labs in 2019. The company later merged with Orbit.'

/**
 * Endpoints default to two entities the passage genuinely names, because that
 * is the ordinary case; the tests that care about anchoring pass their own.
 */
const rel = (quote: string, source = 'Dr. Sarah Chen', target = 'Helix Labs') => ({
  source,
  relation: 'founded',
  target,
  quote,
})

describe('validateExtraction', () => {
  it('keeps a relation whose quote is a verbatim substring', () => {
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Dr. Sarah Chen founded Helix Labs')] },
      text,
    )
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toHaveLength(0)
  })

  it('drops a fabricated quote', () => {
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Sarah Chen sold Helix Labs to Orbit')] },
      text,
    )
    expect(r.kept).toHaveLength(0)
    expect(r.dropped).toHaveLength(1)
  })

  it('tolerates whitespace normalisation but not word changes', () => {
    const spaced = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Dr.  Sarah   Chen founded\nHelix Labs')] },
      text,
    )
    expect(spaced.kept).toHaveLength(1)

    const altered = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Dr. Sara Chen founded Helix Labs')] },
      text,
    )
    expect(altered.kept).toHaveLength(0)
  })

  it('drops an empty or single-word quote as unsupportive', () => {
    expect(
      validateExtraction({ chunkId: 'c1', entities: [], relations: [rel('')] }, text).kept,
    ).toHaveLength(0)
    expect(
      validateExtraction({ chunkId: 'c1', entities: [], relations: [rel('founded')] }, text).kept,
    ).toHaveLength(0)
  })

  it('drops a two-word quote and keeps a three-word one', () => {
    expect(
      validateExtraction({ chunkId: 'c1', entities: [], relations: [rel('founded Helix')] }, text)
        .kept,
    ).toHaveLength(0)
    expect(
      validateExtraction(
        { chunkId: 'c1', entities: [], relations: [rel('founded Helix Labs')] },
        text,
      ).kept,
    ).toHaveLength(1)
  })

  it('tolerates the line breaks PDF extraction inserts mid-sentence', () => {
    const pdfText = 'Dr. Sarah Chen\nfounded   Helix\r\nLabs in 2019.'
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Dr. Sarah Chen founded Helix Labs')] },
      pdfText,
    )
    expect(r.kept).toHaveLength(1)
  })

  it('rejects a subtly altered name — this is exactly where hallucination hides', () => {
    for (const bad of [
      'Dr. Sara Chen founded Helix Labs', // dropped letter
      'Dr. Sarah Chen founded Helix Lab', // singularised
      'Dr. Sarah Chen co-founded Helix Labs', // verb tampered
      'Dr. Sarah Chen founded the Helix Labs', // inserted word
      'Sarah Chen founded Helix Labs in 2020', // changed date
    ]) {
      const r = validateExtraction({ chunkId: 'c1', entities: [], relations: [rel(bad)] }, text)
      expect(r.kept, bad).toHaveLength(0)
    }
  })

  it('allows a quote that stops before punctuation the model did not copy', () => {
    // The source reads "…merged with Orbit." — dropping the full stop is benign.
    const r = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [rel('later merged with Orbit', 'Helix Labs', 'Orbit')],
      },
      text,
    )
    expect(r.kept).toHaveLength(1)
  })

  it('rejects a quote that begins in the middle of a word', () => {
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('arah Chen founded Helix')] },
      text,
    )
    expect(r.kept).toHaveLength(0)
  })

  it('is case sensitive — a re-cased quote is not verbatim', () => {
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('dr. sarah chen founded helix labs')] },
      text,
    )
    expect(r.kept).toHaveLength(0)
  })

  it('drops relations with a missing or non-string quote', () => {
    const r = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        // Models occasionally omit the field entirely; that must fail closed.
        relations: [{ source: 'a', relation: 'founded', target: 'b' } as never],
      },
      text,
    )
    expect(r.kept).toHaveLength(0)
    expect(r.dropped).toHaveLength(1)
  })

  it('drops relations with an empty source or target', () => {
    const r = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [
          {
            source: '',
            relation: 'founded',
            target: 'Helix Labs',
            quote: 'Dr. Sarah Chen founded Helix Labs',
          },
          {
            source: 'Dr. Sarah Chen',
            relation: 'founded',
            target: '  ',
            quote: 'Dr. Sarah Chen founded Helix Labs',
          },
        ],
      },
      text,
    )
    expect(r.kept).toHaveLength(0)
    expect(r.dropped).toHaveLength(2)
  })

  it('partitions a mixed batch without losing any relation', () => {
    const relations = [
      rel('Dr. Sarah Chen founded Helix Labs'),
      rel('Sarah Chen sold Helix Labs to Orbit'),
      rel('The company later merged with Orbit', 'Helix Labs', 'Orbit'),
      rel('nope'),
    ]
    const r = validateExtraction({ chunkId: 'c1', entities: [], relations }, text)
    expect(r.kept).toHaveLength(2)
    expect(r.dropped).toHaveLength(2)
    expect(r.kept.length + r.dropped.length).toBe(relations.length)
  })

  it('normalises non-breaking spaces and tabs in the source text', () => {
    const weird = 'Dr. Sarah\tChen founded Helix Labs in 2019.'
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Dr. Sarah Chen founded Helix Labs')] },
      weird,
    )
    expect(r.kept).toHaveLength(1)
  })
})

describe('validateExtraction — the quote must be about the relation', () => {
  it('drops a real quote stapled to a claim it does not mention', () => {
    // Every character of this quote is in the passage. It says nothing about
    // Marcus Webb or Rotterdam, and a verbatim-substring test alone cannot tell.
    const r = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [rel('Dr. Sarah Chen founded Helix Labs', 'Marcus Webb', 'Rotterdam')],
      },
      text,
    )
    expect(r.kept).toHaveLength(0)
    expect(r.dropped).toHaveLength(1)
  })

  it('accepts a quote that names either endpoint, not necessarily both', () => {
    // Surface forms vary between passages; resolving that is the resolver's job,
    // so demanding both names here would throw away good relations.
    const sourceOnly = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [rel('Dr. Sarah Chen founded Helix Labs', 'Dr. Sarah Chen', 'Genomics')],
      },
      text,
    )
    expect(sourceOnly.kept).toHaveLength(1)

    const targetOnly = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [rel('Dr. Sarah Chen founded Helix Labs', 'Genomics', 'Helix Labs')],
      },
      text,
    )
    expect(targetOnly.kept).toHaveLength(1)
  })

  it('folds honorifics so the fuller entity name still matches a plainer passage', () => {
    const plain = 'Sarah Chen founded Helix Labs in 2019.'
    const r = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [rel('Sarah Chen founded Helix Labs', 'Dr. Sarah Chen', 'Helix Labs')],
      },
      plain,
    )
    expect(r.kept).toHaveLength(1)
  })

  it('drops a quote that only mentions the endpoint by pronoun', () => {
    // "the two companies" is exactly the shape that reads as evidence and is not.
    const passage =
      'Orbit had been working on the same problem since 2016. ' +
      'For four years the two companies competed for the same grants.'
    const r = validateExtraction(
      {
        chunkId: 'c1',
        entities: [],
        relations: [
          rel('For four years the two companies competed', 'Orbit', 'Helix Labs'),
        ],
      },
      passage,
    )
    expect(r.kept).toHaveLength(0)
  })
})

describe('nameAppearsIn', () => {
  it('matches a whole name and not a longer word containing it', () => {
    expect(nameAppearsIn('Chen founded Helix Labs', 'Chen')).toBe(true)
    expect(nameAppearsIn('A bolt of chenille fabric', 'Chen')).toBe(false)
  })

  it('ignores case, punctuation and honorifics on both sides', () => {
    expect(nameAppearsIn('DR. SARAH CHEN founded it', 'sarah chen')).toBe(true)
    expect(nameAppearsIn('Sarah Chen founded it', 'Dr. Sarah Chen')).toBe(true)
    expect(nameAppearsIn('Jean-Luc Picard spoke', 'Jean Luc Picard')).toBe(true)
  })

  it('is false for an empty name or empty text', () => {
    expect(nameAppearsIn('Chen founded Helix Labs', '')).toBe(false)
    expect(nameAppearsIn('', 'Chen')).toBe(false)
  })
})

describe('normalizeName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('  Sarah   CHEN ')).toBe('sarah chen')
  })

  it('strips honorifics with or without the period', () => {
    expect(normalizeName('Dr. Sarah Chen')).toBe('sarah chen')
    expect(normalizeName('Dr Sarah Chen')).toBe('sarah chen')
    expect(normalizeName('Prof. Sarah Chen')).toBe('sarah chen')
    expect(normalizeName('Mrs Sarah Chen')).toBe('sarah chen')
  })

  it('strips stacked honorifics', () => {
    expect(normalizeName('Prof. Dr. Sarah Chen')).toBe('sarah chen')
  })

  it('never strips an honorific down to nothing', () => {
    expect(normalizeName('Dr.')).toBe('dr')
  })

  it('folds intra-word periods and apostrophes so acronyms match', () => {
    expect(normalizeName('U.S.A.')).toBe('usa')
    expect(normalizeName("O'Brien")).toBe('obrien')
  })

  it('turns separating punctuation into a space', () => {
    expect(normalizeName('Jean-Luc Picard')).toBe('jean luc picard')
    expect(normalizeName('Helix Labs, Inc')).toBe('helix labs inc')
  })
})

describe('normalizeQuote', () => {
  it('collapses every run of whitespace to a single space and trims', () => {
    expect(normalizeQuote('  a \n\t b\r\n c  ')).toBe('a b c')
  })

  it('leaves word characters and punctuation untouched', () => {
    expect(normalizeQuote('Dr. Sarah Chen — "founder"')).toBe('Dr. Sarah Chen — "founder"')
  })
})
