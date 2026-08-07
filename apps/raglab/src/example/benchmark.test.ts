import { describe, expect, it } from 'vitest'
import { verdictFor } from '../components/QuestionDrilldown'
import { chunkWith } from '../lib/chunkers'
import { expandMatrix, isUnreachable } from '../lib/engine'
import { DEFAULT_THRESHOLD, aggregate, bestOverlap } from '../lib/metrics'
import { MAX_RESULTS_BYTES, assertNoVectors } from '../lib/persist'
import { SAMPLE_DOC, SAMPLE_QUESTIONS } from '../samples/founding-documents'
import { EXAMPLE_RUN } from './index'

/**
 * The example is the one artefact in this app that a reader cannot check by
 * running it — that is the entire point of shipping it, and the entire risk. So
 * it is checked here instead, and not with snapshots.
 *
 * Most of what follows re-derives the fixture's numbers from the sample document
 * rather than comparing them to stored copies of themselves. Chunk counts, best
 * overlaps and retrieved spans are all pure geometry: they depend on the text and
 * the chunker settings and on nothing that was bought from OpenAI. If a human
 * ever edits `benchmark.json` — nudging a score, inventing a diagnosis, pasting a
 * plausible excerpt — those derived values stop lining up and these tests fail.
 *
 * The parts that genuinely cannot be recomputed offline are the ranks, because
 * they depend on the embeddings. Those are checked for internal consistency
 * instead: a hit must be `1/rank`, an aggregate must be the mean of its parts.
 */

const { results, questions, provenance, matrix } = EXAMPLE_RUN
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 10)

describe('example fixture — provenance', () => {
  it('records a real run: one charged unit, live dimensions, measured wall clock', () => {
    expect(provenance.quotaUnits).toBe(1)
    expect(provenance.runIds).toBe(1)
    expect(provenance.httpBatches).toBeGreaterThan(0)
    expect(provenance.vectorsPurchased).toBeGreaterThan(0)
    expect(provenance.elapsedMs).toBeGreaterThan(0)
    expect(provenance.cacheAssisted).toBe(false)
    expect(new Date(provenance.capturedAt).getTime()).toBeGreaterThan(0)
  })

  it('names every model in the matrix with the dimension the function returned', () => {
    expect(provenance.models.map((m) => m.id).sort()).toEqual([...matrix.models].sort())
    for (const model of provenance.models) expect(model.dims).toBeGreaterThan(0)
  })

  it('scored at the threshold the metrics module defines', () => {
    expect(provenance.hitThreshold).toBe(DEFAULT_THRESHOLD)
  })

  it('describes the bundled sample and nothing else', () => {
    expect(EXAMPLE_RUN.document.id).toBe(SAMPLE_DOC.id)
    expect(EXAMPLE_RUN.document.characters).toBe(SAMPLE_DOC.text.length)
  })
})

describe('example fixture — the question set is still the labelled one', () => {
  it('carries exactly the sample questions, at the offsets they resolve to today', () => {
    expect(questions.map((q) => q.id)).toEqual(SAMPLE_QUESTIONS.map((q) => q.id))
    for (const [i, question] of questions.entries()) {
      const source = SAMPLE_QUESTIONS[i]!
      expect(question.text).toBe(source.text)
      // Gold offsets are resolved from quotes at load time, so a drifted document
      // moves them. This is the assertion that catches a fixture scored against a
      // revision of the sample that no longer exists.
      expect(question.gold).toEqual(source.gold)
    }
  })

  it('carries gold passages that still match the document at those offsets', () => {
    for (const question of questions) {
      expect(question.goldText).toBe(
        SAMPLE_DOC.text.slice(question.gold.start, question.gold.end),
      )
    }
  })
})

describe('example fixture — no vectors, ever', () => {
  it('passes the same guard the app runs before writing to Postgres', () => {
    expect(() => assertNoVectors(results)).not.toThrow()
  })

  it('stays inside the persisted-run byte budget', () => {
    expect(JSON.stringify(results).length).toBeLessThan(MAX_RESULTS_BYTES)
  })
})

describe('example fixture — it is the whole matrix', () => {
  it('holds every configuration the recorded selection expands to, and no others', () => {
    const expected = expandMatrix(matrix).map((c) => JSON.stringify(c)).sort()
    const actual = results.map((r) => JSON.stringify(r.config)).sort()
    expect(actual).toEqual(expected)
  })

  it('scores every question in every configuration', () => {
    for (const result of results) {
      expect(result.perQuestion.map((p) => p.questionId)).toEqual(questions.map((q) => q.id))
    }
  })
})

describe('example fixture — the numbers re-derive from the document', () => {
  it('reports the chunk count this chunker actually produces on this text', () => {
    for (const { config, chunkCount } of results) {
      const chunks = chunkWith(config.chunker, SAMPLE_DOC.text, {
        size: config.size,
        overlap: config.overlap,
      })
      expect(chunkCount, JSON.stringify(config)).toBe(chunks.length)
    }
  })

  it('reports a best overlap that is pure geometry, recomputable without embeddings', () => {
    for (const result of results) {
      const chunks = chunkWith(result.config.chunker, SAMPLE_DOC.text, {
        size: result.config.size,
        overlap: result.config.overlap,
      })
      for (const outcome of result.perQuestion) {
        const gold = questions.find((q) => q.id === outcome.questionId)!.gold
        const expected = Math.round(bestOverlap(chunks, gold) * 1000) / 1000
        expect(outcome.bestOverlap, `${outcome.questionId} ${JSON.stringify(result.config)}`)
          .toBe(expected)
      }
    }
  })

  it('retrieves spans that are real chunk boundaries of that chunking', () => {
    for (const result of results) {
      const boundaries = new Set(
        chunkWith(result.config.chunker, SAMPLE_DOC.text, {
          size: result.config.size,
          overlap: result.config.overlap,
        }).map((c) => `${c.start}:${c.end}`),
      )
      for (const outcome of result.perQuestion) {
        expect(outcome.spans.length).toBeLessThanOrEqual(result.config.k)
        for (const [start, end] of outcome.spans) {
          expect(boundaries.has(`${start}:${end}`)).toBe(true)
        }
      }
    }
  })

  it('quotes excerpts that appear in the document', () => {
    const flat = SAMPLE_DOC.text.replace(/\s+/g, ' ')
    for (const result of results) {
      for (const outcome of result.perQuestion) {
        for (const excerpt of outcome.retrieved) {
          const body = excerpt.endsWith('…') ? excerpt.slice(0, -1) : excerpt
          expect(flat.includes(body), body.slice(0, 40)).toBe(true)
        }
      }
    }
  })
})

describe('example fixture — the metrics are internally consistent', () => {
  it('has aggregates that are the mean of their own per-question outcomes', () => {
    for (const result of results) {
      const { hitRate, mrr } = aggregate(result.perQuestion)
      close(result.hitRate, hitRate)
      close(result.mrr, mrr)
    }
  })

  it('has a reciprocal rank that agrees with the rank it records', () => {
    for (const result of results) {
      for (const outcome of result.perQuestion) {
        expect(outcome.hit).toBe(outcome.rr > 0)
        if (outcome.hit) {
          expect(outcome.firstHitRank).not.toBeNull()
          expect(outcome.firstHitRank!).toBeLessThanOrEqual(result.config.k)
          close(outcome.rr, 1 / outcome.firstHitRank!)
        } else {
          expect(outcome.rr).toBe(0)
          // A miss with a rank means the answer was found and thrown away past k.
          // A miss without one means no chunk ever covered enough of the answer.
          if (outcome.firstHitRank !== null) {
            expect(outcome.firstHitRank).toBeGreaterThan(result.config.k)
          } else {
            expect(outcome.bestOverlap!).toBeLessThan(DEFAULT_THRESHOLD)
          }
        }
      }
    }
  })

  it('never claims a hit on a configuration that cannot arithmetically have one', () => {
    for (const result of results) {
      for (const outcome of result.perQuestion) {
        const gold = questions.find((q) => q.id === outcome.questionId)!.gold
        if (isUnreachable(gold, result.config)) {
          expect(outcome.hit).toBe(false)
          expect(outcome.firstHitRank).toBeNull()
        }
      }
    }
  })
})

describe('example fixture — the drill-down has something to teach', () => {
  const verdicts = results.flatMap((result) =>
    result.perQuestion.map((outcome) => ({
      result,
      outcome,
      verdict: verdictFor(outcome, result, questions.find((q) => q.id === outcome.questionId)!.gold),
    })))

  it('is not a clean sweep', () => {
    expect(verdicts.some((v) => v.verdict.kind !== 'hit')).toBe(true)
  })

  /**
   * The winner is the row a reader looks at first. If it answered everything, the
   * example teaches that this document is easy and nothing else — which is why
   * the recorded matrix uses k=1 and an 80-character size rather than the
   * comfortable settings that produce a perfect score.
   */
  it('has a top configuration that still missed something, diagnosably', () => {
    const winner = [...results].sort((a, b) => (b.mrr - a.mrr) || (b.hitRate - a.hitRate))[0]!
    const missed = winner.perQuestion.filter((p) => !p.hit)
    expect(missed.length).toBeGreaterThan(0)
    for (const miss of missed) {
      expect(typeof miss.bestOverlap).toBe('number')
      const gold = questions.find((q) => q.id === miss.questionId)!.gold
      expect(['depth', 'boundary', 'impossible'])
        .toContain(verdictFor(miss, winner, gold).kind)
    }
  })

  it('shows a ranking failure: the right chunk found, then discarded below k', () => {
    const depth = verdicts.filter((v) => v.verdict.kind === 'depth')
    expect(depth.length).toBeGreaterThan(0)
    for (const { outcome, result } of depth) {
      expect(outcome.firstHitRank!).toBeGreaterThan(result.config.k)
      expect(outcome.firstHitRank!).toBeLessThanOrEqual(result.chunkCount)
    }
  })

  it('shows an arithmetic failure: a chunk too small to hold half the answer', () => {
    const impossible = verdicts.filter((v) => v.verdict.kind === 'impossible')
    expect(impossible.length).toBeGreaterThan(0)
    for (const { outcome } of impossible) {
      expect(outcome.bestOverlap!).toBeLessThan(DEFAULT_THRESHOLD)
    }
  })

  // No `boundary` verdict appears, and that is a property of the document rather
  // than an omission: every gold passage here is a single clause of 73–166
  // characters, and a contiguous chunking whose windows are at least half that
  // long always lands one window over half of it. A boundary miss needs a
  // chunker that leaves gaps or an answer that straddles a hard wall, and this
  // sample offers neither at any size between 40 and 1600. Asserting its absence
  // would pin a fact about the sample text into a test about the fixture, so this
  // is a comment and not an expectation.
})
