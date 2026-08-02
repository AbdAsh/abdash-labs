import { describe, it, expect } from 'vitest'
import { validateExtraction, normalizeQuote } from './validate'

const text = 'Dr. Sarah Chen founded Helix Labs in 2019. The company later merged with Orbit.'

const rel = (quote: string) => ({ source: 'a', relation: 'founded', target: 'b', quote })

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
      const r = validateExtraction(
        { chunkId: 'c1', entities: [], relations: [rel(bad)] },
        text,
      )
      expect(r.kept, bad).toHaveLength(0)
    }
  })

  it('allows a quote that stops before punctuation the model did not copy', () => {
    // The source reads "…merged with Orbit." — dropping the full stop is benign.
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('later merged with Orbit')] },
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
          { source: '', relation: 'founded', target: 'b', quote: 'Dr. Sarah Chen founded Helix Labs' },
          { source: 'a', relation: 'founded', target: '  ', quote: 'Dr. Sarah Chen founded Helix Labs' },
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
      rel('The company later merged with Orbit'),
      rel('nope'),
    ]
    const r = validateExtraction({ chunkId: 'c1', entities: [], relations }, text)
    expect(r.kept).toHaveLength(2)
    expect(r.dropped).toHaveLength(2)
    expect(r.kept.length + r.dropped.length).toBe(relations.length)
  })

  it('normalises non-breaking spaces and tabs in the source text', () => {
    const weird = 'Dr. Sarah\tChen founded Helix Labs in 2019.'
    const r = validateExtraction(
      { chunkId: 'c1', entities: [], relations: [rel('Dr. Sarah Chen founded Helix Labs')] },
      weird,
    )
    expect(r.kept).toHaveLength(1)
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
