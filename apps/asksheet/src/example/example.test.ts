import { describe, expect, it } from 'vitest'
import { MAX_SAMPLES } from '../lib/profile'
import { assertSingleSelect } from '../lib/validate'
import { findSample } from '../samples'
import { capturedOn, EXAMPLE, exampleSample, prerequisites, provenanceOf } from './index'

/**
 * The fixture is generated, so these are not tests of a hand-maintained file.
 * They guard the two ways a generated file goes wrong: it stops matching the
 * shape the app reads, or it silently stops demonstrating the thing it exists to
 * demonstrate.
 *
 * The privacy assertions matter most. `request` is a verbatim copy of a body that
 * really was posted to the planner, so the same property the README claims of
 * live traffic can be checked here against bytes that actually crossed — no
 * mocking, no reasoning about what the code would have sent.
 */

const HEADLINE = 'Which month had the highest revenue and why is it an outlier?'

describe('example fixture', () => {
  it('was captured against a sample that is still bundled', () => {
    expect(findSample(EXAMPLE.sampleId)).toBeDefined()
    expect(exampleSample().id).toBe(EXAMPLE.sampleId)
  })

  it('records where and when it came from', () => {
    expect(EXAMPLE.endpoint).toMatch(/\/functions\/v1\/asksheet-plan$/)
    expect(EXAMPLE.generatedBy).toContain('capture-example')
    expect(Number.isNaN(new Date(EXAMPLE.capturedAt).getTime())).toBe(false)
  })

  /** A fixture written before this module learned to read it would render half a
   *  page. Better to fail here and be regenerated. */
  it('is a format this loader understands', () => {
    expect(EXAMPLE.schema).toBe(1)
  })

  it('offers three questions', () => {
    expect(EXAMPLE.plans).toHaveLength(3)
  })

  /** The app's stated success criterion, and the question the README promises
   *  works. If a regeneration drops it, the demo stops demonstrating the claim. */
  it('leads with the headline question the README promises', () => {
    expect(EXAMPLE.plans[0]!.question).toBe(HEADLINE)
    expect(EXAMPLE.plans[0]!.request.question).toBe(HEADLINE)
  })

  it('includes a follow-up, so prior SQL as context is actually shown', () => {
    const followUps = EXAMPLE.plans.filter((plan) => plan.follows !== null)
    expect(followUps.length).toBeGreaterThan(0)
    for (const plan of followUps) {
      const parent = EXAMPLE.plans[plan.follows!]!
      // The planner was handed the earlier question and its SQL, and nothing else.
      expect(plan.request.history).toEqual([{ question: parent.question, sql: parent.sql }])
    }
  })

  /** Without this the example never exercises the chart path at all: the planner
   *  only emits a spec when a question asks for a picture. */
  it('includes a question the planner answered with a chart', () => {
    expect(EXAMPLE.plans.some((plan) => plan.chart !== null)).toBe(true)
  })

  it('has a usable plan for every question', () => {
    for (const plan of EXAMPLE.plans) {
      expect(plan.question.trim()).not.toBe('')
      expect(plan.sql.trim()).not.toBe('')
      expect(plan.narration.trim()).not.toBe('')
      expect(plan.requestBytes).toBeGreaterThan(0)
      expect(plan.observed.columns.length).toBeGreaterThan(0)
    }
  })

  /** Saved model output is still model output. A fixture that would be rejected
   *  at runtime is a fixture that has to be regenerated, not shipped. */
  it('holds SQL that passes the same guard a fresh plan does', () => {
    for (const plan of EXAMPLE.plans) {
      expect(() => assertSingleSelect(plan.sql)).not.toThrow()
    }
  })

  it('holds SQL that reads the registered table and nothing else', () => {
    for (const plan of EXAMPLE.plans) {
      expect(plan.sql.toLowerCase()).toContain(EXAMPLE.table)
      expect(plan.sql).not.toMatch(/read_csv|read_parquet|glob|https?:\/\//i)
    }
  })
})

describe('example fixture — what actually crossed the network', () => {
  it('posted exactly the three profile keys, nothing wider', () => {
    for (const plan of EXAMPLE.plans) {
      expect(Object.keys(plan.request).sort()).toEqual(
        plan.request.repair ? ['history', 'profile', 'question', 'repair'] : ['history', 'profile', 'question'],
      )
      expect(Object.keys(plan.request.profile).sort()).toEqual(['columns', 'rowCount', 'table'])
      for (const column of plan.request.profile.columns) {
        expect(Object.keys(column).sort()).toEqual(['name', 'samples', 'type'])
        expect(column.samples.length).toBeLessThanOrEqual(MAX_SAMPLES)
      }
    }
  })

  it('described the sample it was captured against', () => {
    const rows = exampleSample().rows
    for (const plan of EXAMPLE.plans) {
      expect(plan.request.profile.table).toBe(EXAMPLE.table)
      expect(plan.request.profile.rowCount).toBe(rows)
    }
  })

  /**
   * The row-reconstruction property from the README, applied to real captured
   * bytes rather than to a synthesised payload. Counting disclosed values is the
   * wrong measure; what can be rebuilt from them is the right one.
   */
  it('sent nothing from which a source row can be rebuilt', () => {
    const lines = exampleSample().csv.trim().split('\n')
    const sourceRows = lines.slice(1).map((line) => line.split(','))

    for (const plan of EXAMPLE.plans) {
      const sampleSets = plan.request.profile.columns.map((column) => new Set(column.samples))
      const reconstructible = sourceRows.filter((row) =>
        row.every((value, index) => sampleSets[index]?.has(value)),
      )
      expect(reconstructible).toHaveLength(0)
    }
  })

  it('carries no result anywhere in the recording', () => {
    // History is question and SQL pairs. If a `result`, `rows` or `values` key
    // ever appears in one, something has started forwarding data.
    for (const plan of EXAMPLE.plans) {
      for (const turn of plan.request.history) {
        expect(Object.keys(turn).sort()).toEqual(['question', 'sql'])
      }
    }
  })
})

describe('prerequisites', () => {
  it('is empty for a question that stands alone', () => {
    expect(prerequisites(0)).toEqual([])
  })

  it('returns the chain oldest first', () => {
    const index = EXAMPLE.plans.findIndex((plan) => plan.follows !== null)
    expect(index).toBeGreaterThan(-1)
    expect(prerequisites(index)).toEqual([EXAMPLE.plans[index]!.follows])
  })

  it('terminates on an out-of-range index rather than looping', () => {
    expect(prerequisites(99)).toEqual([])
  })
})

describe('provenanceOf', () => {
  it('names the question a follow-up followed', () => {
    const index = EXAMPLE.plans.findIndex((plan) => plan.follows !== null)
    const plan = EXAMPLE.plans[index]!
    expect(provenanceOf(plan).followsQuestion).toBe(EXAMPLE.plans[plan.follows!]!.question)
  })

  it('leaves a standalone question without a predecessor', () => {
    expect(provenanceOf(EXAMPLE.plans[0]!).followsQuestion).toBeNull()
  })

  it('carries the byte count the label quotes', () => {
    expect(provenanceOf(EXAMPLE.plans[0]!).requestBytes).toBe(EXAMPLE.plans[0]!.requestBytes)
  })
})

describe('capturedOn', () => {
  it('renders a readable date', () => {
    expect(capturedOn('2026-08-07T14:41:00.494Z')).toBe('7 August 2026')
  })

  it('does not render "Invalid Date" into the label', () => {
    expect(capturedOn('not a date')).toBe('an earlier date')
  })

  it('defaults to the fixture it belongs to', () => {
    expect(capturedOn()).toBe(capturedOn(EXAMPLE.capturedAt))
  })
})
