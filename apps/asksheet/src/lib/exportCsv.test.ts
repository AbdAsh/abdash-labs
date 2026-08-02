import { describe, expect, it } from 'vitest'
import { csvFilename, resultToCsv } from './exportCsv'
import type { QueryResult } from './types'

const result = (rows: unknown[][]): QueryResult => ({
  columns: [
    { name: 'month', type: 'VARCHAR' },
    { name: 'revenue', type: 'DOUBLE' },
  ],
  rows,
  elapsedMs: 1,
  truncated: false,
})

describe('resultToCsv', () => {
  it('writes a header and one line per row', () => {
    expect(resultToCsv(result([['2025-03', 1200]]))).toBe('month,revenue\n2025-03,1200\n')
  })

  it('emits a header-only file for an empty result', () => {
    expect(resultToCsv(result([]))).toBe('month,revenue\n')
  })

  it('quotes values containing a comma, a quote or a newline', () => {
    const csv = resultToCsv(result([['a,b', 'say "hi"'], ['line\nbreak', 1]]))
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"say ""hi"""')
    expect(csv).toContain('"line\nbreak"')
  })

  it('writes null and undefined as empty fields rather than the word null', () => {
    expect(resultToCsv(result([[null, undefined]]))).toBe('month,revenue\n,\n')
  })

  it('serialises a nested value as JSON instead of [object Object]', () => {
    expect(resultToCsv(result([[{ a: 1 }, 2]]))).toContain('"{""a"":1}"')
  })
})

describe('csvFilename', () => {
  it('slugifies the question', () => {
    expect(csvFilename('Which month had the highest revenue?')).toBe(
      'asksheet-which-month-had-the-highest-revenue.csv',
    )
  })

  it('falls back when the question has nothing usable in it', () => {
    expect(csvFilename('???')).toBe('asksheet-result.csv')
  })

  it('keeps the name short', () => {
    expect(csvFilename('x'.repeat(200)).length).toBeLessThanOrEqual(64)
  })
})
