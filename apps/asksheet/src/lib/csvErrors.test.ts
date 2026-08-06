import { describe, expect, it } from 'vitest'
import {
  describeCsvProblem,
  describeLoadFailure,
  describeQueryFailure,
  type CsvPreflight,
} from './csvErrors'
// Imported as the real classes rather than as `{ name: 'QueryTimeoutError' }`:
// the passthrough is keyed on `error.name`, so a rename should break this test.
import { FileTooLargeError, QueryTimeoutError } from './duck'

const clean: CsvPreflight = {
  issues: [],
  meta: { delimiter: ',', fields: ['month', 'revenue_usd'] },
  sampledRows: 10,
}

describe('describeCsvProblem', () => {
  it('returns null for a healthy file', () => {
    expect(describeCsvProblem(clean)).toBeNull()
  })

  it('explains a missing header', () => {
    expect(describeCsvProblem({ ...clean, meta: { fields: [] } })).toMatch(/no header row/i)
  })

  it('names the delimiter it guessed when only one column came back', () => {
    const message = describeCsvProblem({
      ...clean,
      meta: { delimiter: ',', fields: ['month;revenue'] },
    })
    expect(message).toMatch(/only one column/i)
    expect(message).toMatch(/comma/)
  })

  it('flags an unnamed column', () => {
    expect(describeCsvProblem({ ...clean, meta: { delimiter: ',', fields: ['a', '  '] } })).toMatch(
      /empty name/i,
    )
  })

  it('flags duplicate column names and quotes the offender', () => {
    const message = describeCsvProblem({
      ...clean,
      meta: { delimiter: ',', fields: ['month', 'Month'] },
    })
    expect(message).toMatch(/unique/i)
    expect(message).toContain('"Month"')
  })

  it('explains an undetectable delimiter', () => {
    expect(
      describeCsvProblem({ ...clean, issues: [{ code: 'UndetectableDelimiter' }] }),
    ).toMatch(/separator could not be detected/i)
  })

  it('points at the line for an unterminated quote', () => {
    const message = describeCsvProblem({
      ...clean,
      issues: [{ code: 'MissingQuotes', row: 40 }],
    })
    expect(message).toMatch(/never closed/i)
    expect(message).toContain('line 42') // row 40 is zero-based and below the header
  })

  it('summarises ragged rows into one sentence with a count and a line number', () => {
    const message = describeCsvProblem({
      ...clean,
      issues: [
        { code: 'TooFewFields', row: 3 },
        { code: 'TooFewFields', row: 7 },
        { code: 'TooManyFields', row: 9 },
      ],
    })
    expect(message).toMatch(/3 rows have fewer values/i)
    expect(message).toContain('line 5')
    expect(message).toContain('2 columns')
  })

  it('does not list every ragged row individually', () => {
    const issues = Array.from({ length: 500 }, (_v, i) => ({ code: 'TooFewFields', row: i }))
    const message = describeCsvProblem({ ...clean, issues })!
    expect(message.split('\n')).toHaveLength(1)
    expect(message.length).toBeLessThan(220)
  })

  it('notices a header with no data under it', () => {
    expect(describeCsvProblem({ ...clean, sampledRows: 0 })).toMatch(/no data rows/i)
  })

  it('prefers the structural problem over the parser noise it caused', () => {
    const message = describeCsvProblem({
      issues: [{ code: 'TooFewFields', row: 1 }],
      meta: { delimiter: ',', fields: ['a', 'a'] },
      sampledRows: 5,
    })
    expect(message).toMatch(/unique/i)
  })
})

describe('describeLoadFailure', () => {
  const cases: [string, RegExp][] = [
    ['Value with unterminated quote found at line 12', /stray " character/],
    ['Error when sniffing file', /re-export it as a standard csv/i],
    ['Conversion Error: Could not convert string "n/a" to DOUBLE', /did not match its column/i],
    ['RuntimeError: Out of Memory', /more memory than the tab has/i],
  ]

  for (const [raw, expected] of cases) {
    it(`rewrites: ${raw.slice(0, 36)}…`, () => {
      expect(describeLoadFailure(new Error(raw))).toMatch(expected)
    })
  }

  it('falls back to the raw message rather than swallowing it', () => {
    expect(describeLoadFailure(new Error('something odd'))).toContain('something odd')
  })

  it('copes with a thrown non-Error', () => {
    expect(describeLoadFailure('plain string')).toContain('plain string')
  })
})

describe('describeQueryFailure', () => {
  const cases: [string, RegExp][] = [
    ['Binder Error: Referenced column "x" not found in FROM clause!', /column this sheet does not have/i],
    ['Catalog Error: Table with name foo does not exist', /column this sheet does not have/i],
    ["Conversion Error: Could not convert string 'n/a' to INT32", /set its type/i],
    ['Parser Error: syntax error at or near ";"', /could not parse/i],
    ['Binder Error: No function matches the given name', /rejected/i],
    ['RuntimeError: Out of Memory', /summary or a top-N/i],
  ]

  for (const [raw, expected] of cases) {
    it(`suggests a next step for: ${raw.slice(0, 34)}…`, () => {
      expect(describeQueryFailure(new Error(raw))).toMatch(expected)
    })
  }

  it('never returns the bare DuckDB text as the headline', () => {
    const headline = describeQueryFailure(new Error('Binder Error: Referenced column "x" not found'))
    expect(headline).not.toContain('Binder Error')
  })

  it('has a fallback for an error it does not recognise', () => {
    expect(describeQueryFailure(new Error('???'))).toMatch(/could not be answered/i)
  })

  /**
   * AskSheet's own errors were written to be read. Passing them through the
   * pattern matcher would replace a specific, actionable sentence with a generic
   * one — the timeout would become "that question could not be answered".
   */
  it('passes through an error that is already a sentence', () => {
    const timeout = new QueryTimeoutError(10_000)
    expect(describeQueryFailure(timeout)).toBe(timeout.message)
    const big = new FileTooLargeError(200 * 1024 * 1024)
    expect(describeLoadFailure(big)).toBe(big.message)
  })
})
