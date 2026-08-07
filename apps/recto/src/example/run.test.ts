import { describe, expect, it } from 'vitest'
import { parseExampleRun, exampleRun, capturedOn } from './run'
import raw from './example-run.json'
import { QUESTIONS, SOURCE_DOCUMENTS } from '../../scripts/source-documents.mjs'

/** The fixture is JSON: untyped by nature, and reshaped here on purpose. */
type Json = Record<string, any> // eslint-disable-line

/** A minimal run that parses, so each test can break exactly one thing in it. */
function valid(): Json {
  return {
    provenance: {
      capturedAt: '2026-08-07T14:43:35.016Z',
      tier: { notebooks: 1, documents: 3, messages: 20 },
    },
    models: { embedding: 'text-embedding-3-small', answer: 'openai/gpt-4o-mini' },
    fiction: { company: 'Nowhere Ltd', statement: 'It does not exist.' },
    notebook: { id: 'n1', title: 'Two quarters', createdAt: '2026-08-07T14:43:06Z' },
    documents: [1, 2].map((i) => ({
      id: `d${i}`,
      name: `doc ${i}.pdf`,
      pageCount: 5,
      isRtl: false,
      status: 'ready',
      createdAt: '2026-08-07T14:43:09Z',
      contentHash: 'abc',
      chunkCount: 5,
    })),
    conversation: { id: 'c1', title: 'A question' },
    turns: [
      {
        question: 'A question?',
        answer: 'An answer [1].',
        citations: [{ n: 1, page: 3, document: 'doc 1.pdf', content: 'a passage', similarity: 0.7 }],
        http: { elapsedMs: 4200 },
      },
    ],
  }
}

/** The valid run with one thing wrong with it. */
function broken(spoil: (fixture: Json) => void): Json {
  const fixture = valid()
  spoil(fixture)
  return fixture
}

describe('parseExampleRun', () => {
  it('narrows a well-formed run to the shape the interface renders', () => {
    const run = parseExampleRun(valid())
    expect(run.documents).toHaveLength(2)
    expect(run.turns[0]?.citations[0]?.page).toBe(3)
    expect(run.turns[0]?.elapsedMs).toBe(4200)
    expect(run.tier.messages).toBe(20)
  })

  it('keeps a null page rather than coercing it to zero', () => {
    const run = parseExampleRun(broken((f) => (f.turns[0].citations[0].page = null)))
    expect(run.turns[0]?.citations[0]?.page).toBeNull()
  })

  it('names the field that is wrong, and says how to fix the file', () => {
    const fixture = broken((f) => (f.notebook.title = ''))
    expect(() => parseExampleRun(fixture)).toThrow(/notebook\.title/)
    expect(() => parseExampleRun(fixture)).toThrow(/npm run example/)
  })

  it('refuses a run with only one document, which can prove nothing', () => {
    expect(() => parseExampleRun(broken((f) => (f.documents = [f.documents[0]])))).toThrow(
      /cross-document/,
    )
  })

  // A document left at 'indexing' is invisible to `match_chunks`, so a run
  // captured against one recorded answers drawn from a fraction of it.
  it('refuses a document that never reached ready', () => {
    expect(() => parseExampleRun(broken((f) => (f.documents[1].status = 'indexing')))).toThrow(
      /never searchable/,
    )
  })

  // Out-of-range markers are the one malformation that looks fine and is not:
  // `Turn` leaves them as plain text, so the footnote a reviewer clicks does
  // nothing at all.
  it('refuses an answer citing a passage that was not retrieved', () => {
    expect(() => parseExampleRun(broken((f) => (f.turns[0].answer = 'An answer [4].')))).toThrow(
      /cites \[4\] but only 1/,
    )
  })

  it('refuses citations that are not numbered from one', () => {
    expect(() => parseExampleRun(broken((f) => (f.turns[0].citations[0].n = 2)))).toThrow(
      /is 2, not 1/,
    )
  })

  it('refuses a capturedAt that is not a date', () => {
    expect(() => parseExampleRun(broken((f) => (f.provenance.capturedAt = 'recently')))).toThrow(
      /capturedAt is not a date/,
    )
  })
})

describe('capturedOn', () => {
  it('writes the month out, because 07/08 is two different days', () => {
    expect(capturedOn('2026-08-07T14:43:35.016Z', 'en-GB')).toBe('7 August 2026')
  })
})

/**
 * These run against the committed fixture, not a hand-made one.
 *
 * The example exists to make one claim visible: that retrieval spans every
 * document in a notebook and stays attributable across them. A regenerated run
 * where no answer reaches into both documents still renders perfectly and
 * quietly stops making that claim — so it fails here instead of shipping.
 */
describe('the committed example run', () => {
  it('parses', () => {
    expect(() => parseExampleRun(raw)).not.toThrow()
  })

  it('was captured from the deployed functions, and says so', () => {
    expect(raw.provenance.generator).toBe('apps/recto/scripts/generate-example.mjs')
    expect(raw.provenance.functions).toEqual(['recto-ingest', 'recto-chat'])
    expect(raw.provenance.supabaseUrl).toMatch(/^https:\/\/.+\.supabase\.co$/)
    expect(Date.parse(exampleRun.capturedAt)).toBeLessThanOrEqual(Date.now())
  })

  it('asks exactly the questions the generator script asks', () => {
    expect(exampleRun.turns.map((t) => t.question)).toEqual(QUESTIONS)
  })

  it('holds the two documents the generator script builds', () => {
    expect(exampleRun.documents.map((d) => d.name)).toEqual(SOURCE_DOCUMENTS.map((d) => d.name))
    for (const doc of exampleRun.documents) {
      expect(doc.pageCount).toBe(SOURCE_DOCUMENTS[0].pages.length)
      expect(doc.chunkCount).toBe(SOURCE_DOCUMENTS[0].pages.length)
    }
  })

  it('has at least one answer whose inline citations reach into both documents', () => {
    const spanning = exampleRun.turns.filter((turn) => {
      const cited = new Set<string>()
      for (const marker of turn.answer.matchAll(/\[(\d+)\]/g)) {
        const source = turn.citations[Number(marker[1]) - 1]
        if (source) cited.add(source.document)
      }
      return cited.size > 1
    })
    expect(spanning.length).toBeGreaterThan(0)
  })

  it('retrieves from both documents on every turn, because retrieval is notebook-wide', () => {
    for (const turn of exampleRun.turns) {
      expect(new Set(turn.citations.map((c) => c.document)).size).toBe(2)
    }
  })

  // Similarity is a cosine score from `match_chunks` and the list is ordered by
  // it. An unordered list would mean the fixture had been assembled rather than
  // recorded.
  it('lists passages in descending similarity, as the database returned them', () => {
    for (const turn of exampleRun.turns) {
      const scores = turn.citations.map((c) => c.similarity)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
      for (const score of scores) expect(score).toBeGreaterThan(0)
    }
  })

  it('answers something, on every turn', () => {
    for (const turn of exampleRun.turns) {
      expect(turn.answer.length).toBeGreaterThan(80)
      expect(turn.elapsedMs).toBeGreaterThan(0)
    }
  })
})
