import { describe, it, expect } from 'vitest'
import { SAMPLE_DOC } from '../samples/founding-documents'
import type { Question } from './metrics'
import {
  MIN_QUESTIONS,
  heuristicSuggester,
  locateQuote,
  readyToRun,
  suggestQuestions,
  validateGold,
  type Suggester,
} from './questions'

const text = 'Alpha is the first letter. Beta is the second letter. Gamma is the third one.'

describe('locateQuote', () => {
  it('finds a unique quote', () => {
    expect(locateQuote(text, 'Beta is the second letter.')).toEqual({ start: 27, end: 53 })
  })

  it('slices back to the quote it located', () => {
    const span = locateQuote(text, 'Gamma is the third one.')!
    expect(text.slice(span.start, span.end)).toBe('Gamma is the third one.')
  })

  it('tolerates surrounding whitespace in the quote', () => {
    expect(locateQuote(text, '  Beta is the second letter.  ')).toEqual({ start: 27, end: 53 })
  })

  it('returns null for a quote that is not present', () => {
    expect(locateQuote(text, 'Delta is the fourth letter.')).toBeNull()
  })

  // Two matches means two possible answers, so the label is not a label.
  it('returns null for an ambiguous quote', () => {
    expect(locateQuote('same same', 'same')).toBeNull()
  })

  it('returns null for an empty quote', () => {
    expect(locateQuote(text, '   ')).toBeNull()
  })
})

describe('validateGold', () => {
  const q = (gold: { start: number; end: number }, qtext = 'why?'): Question =>
    ({ id: 'q', text: qtext, gold })

  it('accepts a span inside the document', () => {
    expect(validateGold(text, q({ start: 0, end: 26 }))).toBe(true)
  })

  it('rejects a span past the end of the document', () => {
    expect(validateGold(text, q({ start: 0, end: text.length + 1 }))).toBe(false)
  })

  it('rejects an inverted or empty span', () => {
    expect(validateGold(text, q({ start: 30, end: 10 }))).toBe(false)
    expect(validateGold(text, q({ start: 30, end: 30 }))).toBe(false)
  })

  it('rejects a negative start', () => {
    expect(validateGold(text, q({ start: -1, end: 26 }))).toBe(false)
  })

  it('rejects a span too short to be a real answer', () => {
    expect(validateGold(text, q({ start: 0, end: 5 }))).toBe(false)
  })

  it('rejects a question with no text', () => {
    expect(validateGold(text, q({ start: 0, end: 26 }, '   '))).toBe(false)
  })
})

describe('suggestQuestions', () => {
  it('drops suggestions whose quote cannot be located', async () => {
    const suggester: Suggester = async () => [
      { id: 'a', text: 'good?', quote: 'Beta is the second letter.' },
      { id: 'b', text: 'bad?', quote: 'A passage that is not in the document at all.' },
    ]
    const out = await suggestQuestions(text, 2, suggester)
    expect(out.map((q) => q.id)).toEqual(['a'])
  })

  it('drops suggestions whose quote is ambiguous', async () => {
    const suggester: Suggester = async () => [
      { id: 'a', text: 'which one?', quote: 'letter' },
    ]
    expect(await suggestQuestions(text, 1, suggester)).toEqual([])
  })

  it('derives offsets that slice back to the suggested quote', async () => {
    const quote = 'Alpha is the first letter.'
    const suggester: Suggester = async () => [{ id: 'a', text: 'q?', quote }]
    const [q] = await suggestQuestions(text, 1, suggester)
    expect(text.slice(q!.gold.start, q!.gold.end)).toBe(quote)
  })
})

describe('heuristicSuggester', () => {
  it('proposes the requested number of candidates from a real document', async () => {
    const out = await heuristicSuggester(SAMPLE_DOC.text, 10)
    expect(out).toHaveLength(10)
  })

  it('proposes only passages that exist verbatim and exactly once', async () => {
    for (const s of await heuristicSuggester(SAMPLE_DOC.text, 10)) {
      expect(locateQuote(SAMPLE_DOC.text, s.quote)).not.toBeNull()
    }
  })

  it('spreads candidates across the document instead of clustering', async () => {
    const questions = await suggestQuestions(SAMPLE_DOC.text, 10)
    const starts = questions.map((q) => q.gold.start).sort((a, b) => a - b)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(200)
    }
  })

  it('produces labels that all pass validation', async () => {
    for (const q of await suggestQuestions(SAMPLE_DOC.text, 10)) {
      expect(validateGold(SAMPLE_DOC.text, q)).toBe(true)
    }
  })

  it('returns nothing for a document with no sentences', async () => {
    expect(await heuristicSuggester('short', 5)).toEqual([])
  })
})

describe('readyToRun', () => {
  const make = (n: number): Question[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      text: 'why?',
      gold: { start: 0, end: 26 },
    }))

  it('blocks below the minimum and says how many are missing', () => {
    const result = readyToRun(text, make(MIN_QUESTIONS - 1))
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(new RegExp(String(MIN_QUESTIONS)))
  })

  it('allows exactly the minimum', () => {
    expect(readyToRun(text, make(MIN_QUESTIONS)).ok).toBe(true)
  })

  it('ignores invalid questions when counting', () => {
    const questions = [...make(MIN_QUESTIONS), { id: 'bad', text: '', gold: { start: 0, end: 1 } }]
    expect(readyToRun(text, questions).ok).toBe(true)
    expect(readyToRun(text, [questions[5]!]).ok).toBe(false)
  })

  it('rejects duplicate ids', () => {
    const dup = make(MIN_QUESTIONS).map((q) => ({ ...q, id: 'same' }))
    expect(readyToRun(text, dup)).toEqual({ ok: false, reason: 'Two questions share an id.' })
  })
})
