import { describe, expect, it } from 'vitest'
import { starterQuestions } from './starters'
import type { ColumnInfo } from './types'

const revenue: ColumnInfo[] = [
  { name: 'month', type: 'VARCHAR' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'plan', type: 'VARCHAR' },
  { name: 'new_customers', type: 'BIGINT' },
  { name: 'revenue_usd', type: 'DOUBLE' },
]

describe('starterQuestions', () => {
  it('returns nothing for an empty schema', () => {
    expect(starterQuestions([])).toEqual([])
  })

  it('returns exactly three suggestions', () => {
    expect(starterQuestions(revenue)).toHaveLength(3)
  })

  it('prefers a column that reads like a measure over one that merely is numeric', () => {
    expect(starterQuestions(revenue).join(' ')).toContain('revenue_usd')
  })

  it('prefers a column that reads like a dimension for grouping', () => {
    expect(starterQuestions(revenue).some((q) => q.includes('by region'))).toBe(true)
  })

  it('uses a date-like column name even when its type is VARCHAR', () => {
    expect(starterQuestions(revenue).some((q) => q.includes('over month'))).toBe(true)
  })

  it('uses a real DATE column when there is one', () => {
    const columns: ColumnInfo[] = [
      { name: 'opened_at', type: 'TIMESTAMP' },
      { name: 'hours', type: 'DOUBLE' },
    ]
    expect(starterQuestions(columns)[0]).toContain('opened_at')
  })

  it('still produces three questions for a schema with no numbers at all', () => {
    const columns: ColumnInfo[] = [
      { name: 'name', type: 'VARCHAR' },
      { name: 'status', type: 'VARCHAR' },
    ]
    const questions = starterQuestions(columns)
    expect(questions).toHaveLength(2)
    expect(questions.join(' ')).toMatch(/status/)
  })

  it('produces a generic fallback for a single unhelpful column', () => {
    expect(starterQuestions([{ name: 'blob', type: 'BLOB' }])).toEqual([
      'How many rows are there per blob?',
      'Summarise this table in a few numbers',
    ])
  })

  it('names only columns that exist', () => {
    const names = revenue.map((c) => c.name)
    for (const question of starterQuestions(revenue)) {
      const mentioned = names.filter((name) => question.includes(name))
      expect(mentioned.length).toBeGreaterThan(0)
    }
  })
})
