import { describe, expect, it } from 'vitest'
import { findSample, SAMPLES } from './index'

/**
 * These guard a success criterion, not an implementation detail: "the bundled
 * sample answers *which month had the highest revenue and why is it an outlier?*
 * correctly". If someone regenerates the CSV and flattens the spike, the demo
 * silently stops demonstrating anything — so the spike is asserted here.
 */

function parse(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.trim().split('\n')
  return {
    header: lines[0]!.split(','),
    rows: lines.slice(1).map((line) => line.split(',')),
  }
}

describe('bundled samples', () => {
  it('ships exactly the two advertised datasets', () => {
    expect(SAMPLES.map((s) => s.id)).toEqual(['saas-revenue', 'support-tickets'])
    expect(findSample('saas-revenue')).toBeDefined()
    expect(findSample('nope')).toBeUndefined()
  })

  for (const sample of SAMPLES) {
    describe(sample.id, () => {
      it('is non-empty and has the row count it advertises', () => {
        const { rows } = parse(sample.csv)
        expect(rows.length).toBe(sample.rows)
      })

      it('has a rectangular shape, so DuckDB will not reject it', () => {
        const { header, rows } = parse(sample.csv)
        expect(header.length).toBeGreaterThan(2)
        for (const row of rows) expect(row).toHaveLength(header.length)
      })

      it('offers starter questions', () => {
        expect(sample.questions.length).toBeGreaterThanOrEqual(3)
      })

      it('stays small enough to bundle', () => {
        expect(sample.csv.length).toBeLessThan(120_000)
      })
    })
  }
})

describe('saas-revenue outlier — the headline demo', () => {
  const { header, rows } = parse(findSample('saas-revenue')!.csv)
  const monthIndex = header.indexOf('month')
  const revenueIndex = header.indexOf('revenue_usd')
  const contractIndex = header.indexOf('contract_type')

  const byMonth = new Map<string, number>()
  for (const row of rows) {
    const month = row[monthIndex]!
    byMonth.set(month, (byMonth.get(month) ?? 0) + Number(row[revenueIndex]))
  }
  const ranked = [...byMonth].sort((a, b) => b[1] - a[1])

  it('covers 24 distinct months', () => {
    expect(byMonth.size).toBe(24)
  })

  it('has 2025-03 as the highest-revenue month', () => {
    expect(ranked[0]![0]).toBe('2025-03')
  })

  it('makes the winner unmistakable rather than a coin toss', () => {
    expect(ranked[0]![1] / ranked[1]![1]).toBeGreaterThan(2)
  })

  it('puts the outlier more than three standard deviations above the mean', () => {
    const totals = [...byMonth.values()]
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length
    const sigma = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length)
    expect((ranked[0]![1] - mean) / sigma).toBeGreaterThan(3)
  })

  it('explains itself: the spike is a single annual prepayment visible in the data', () => {
    const marchPrepay = rows.filter(
      (row) => row[monthIndex] === '2025-03' && row[contractIndex] === 'annual_prepay',
    )
    expect(marchPrepay).toHaveLength(1)
    expect(Number(marchPrepay[0]![revenueIndex])).toBeGreaterThan(800_000)
  })

  it('has other prepayments too, so contract_type is a pattern and not a tell', () => {
    const prepay = rows.filter((row) => row[contractIndex] === 'annual_prepay')
    expect(prepay.length).toBeGreaterThan(1)
  })
})

describe('support-tickets shape', () => {
  const { header, rows } = parse(findSample('support-tickets')!.csv)

  it('has the columns the starter questions rely on', () => {
    for (const column of ['category', 'priority', 'resolution_hours', 'first_response_minutes']) {
      expect(header).toContain(column)
    }
  })

  it('includes open tickets, so NULL handling is exercised by the demo', () => {
    const resolution = header.indexOf('resolution_hours')
    expect(rows.some((row) => row[resolution] === '')).toBe(true)
  })

  it('has integrations as the slowest category, so a follow-up question has an answer', () => {
    const category = header.indexOf('category')
    const resolution = header.indexOf('resolution_hours')
    const totals = new Map<string, { sum: number; n: number }>()
    for (const row of rows) {
      if (row[resolution] === '') continue
      const bucket = totals.get(row[category]!) ?? { sum: 0, n: 0 }
      bucket.sum += Number(row[resolution])
      bucket.n += 1
      totals.set(row[category]!, bucket)
    }
    const ranked = [...totals].sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)
    expect(ranked[0]![0]).toBe('feature_request')
    expect(ranked.slice(0, 2).map(([name]) => name)).toContain('integrations')
  })
})
