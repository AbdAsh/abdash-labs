import { describe, expect, it } from 'vitest'
import { derivedFields, MAX_CHART_ROWS, referencedFields, rowsToRecords, toChartSpec } from './chart'
import type { QueryResult } from './types'

const result: QueryResult = {
  columns: [
    { name: 'month', type: 'VARCHAR' },
    { name: 'revenue', type: 'DOUBLE' },
  ],
  rows: [
    ['2025-02', 400],
    ['2025-03', 1200],
  ],
  elapsedMs: 3,
  truncated: false,
}

const barSpec = {
  mark: 'bar',
  encoding: {
    x: { field: 'month', type: 'ordinal' },
    y: { field: 'revenue', type: 'quantitative' },
  },
}

describe('rowsToRecords', () => {
  it('zips columns and rows into objects', () => {
    expect(rowsToRecords(result)).toEqual([
      { month: '2025-02', revenue: 400 },
      { month: '2025-03', revenue: 1200 },
    ])
  })

  it('returns an empty array for an empty result', () => {
    expect(rowsToRecords({ ...result, rows: [] })).toEqual([])
  })
})

describe('referencedFields', () => {
  it('finds fields at any depth', () => {
    const spec = {
      layer: [{ encoding: { x: { field: 'a' } } }, { encoding: { y: { field: 'b' } } }],
      transform: [{ filter: { field: 'c', equal: 1 } }],
    }
    expect([...referencedFields(spec)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('ignores a key called field that does not hold a string', () => {
    expect([...referencedFields({ field: { nested: true } })]).toEqual([])
  })
})

describe('toChartSpec', () => {
  it('injects the result as the data source', () => {
    const spec = toChartSpec(barSpec, result)!
    expect(spec.data).toEqual({ values: rowsToRecords(result) })
  })

  it('discards any data the model invented', () => {
    const spec = toChartSpec({ ...barSpec, data: { values: [{ month: 'FAKE' }] } }, result)!
    expect(JSON.stringify(spec.data)).not.toContain('FAKE')
  })

  it('makes the chart responsive rather than fixed width', () => {
    expect(toChartSpec(barSpec, result)!.width).toBe('container')
  })

  it('pins a Vega-Lite schema so the renderer does not have to guess', () => {
    expect(String(toChartSpec(barSpec, result)!.$schema)).toContain('vega-lite')
  })

  it('keeps the mark and encoding the model chose', () => {
    const spec = toChartSpec(barSpec, result)!
    expect(spec.mark).toBe('bar')
    expect(spec.encoding).toEqual(barSpec.encoding)
  })

  it('returns null when the spec references a column the SQL did not return', () => {
    const bad = { mark: 'bar', encoding: { x: { field: 'nope' } } }
    expect(toChartSpec(bad, result)).toBeNull()
  })

  it('returns null when there is no spec', () => {
    expect(toChartSpec(undefined, result)).toBeNull()
  })

  it('returns null for an empty result rather than an empty chart', () => {
    expect(toChartSpec(barSpec, { ...result, rows: [] })).toBeNull()
  })

  it('returns null past the chart row limit, where a table is more honest', () => {
    const many = {
      ...result,
      rows: Array.from({ length: MAX_CHART_ROWS + 1 }, (_v, i) => [`m${i}`, i]),
    }
    expect(toChartSpec(barSpec, many)).toBeNull()
  })

  it('returns null for a spec that references nothing at all', () => {
    expect(toChartSpec({ mark: 'point' }, result)).toBeNull()
  })
})

/**
 * The field check exists so a chart of blanks never replaces a good table. But it
 * was matching `field` against the SQL result columns alone, and Vega-Lite
 * transforms invent columns: `{"calculate": …, "as": "share"}` followed by
 * `{"y": {"field": "share"}}` is a valid, common spec that looked exactly like a
 * hallucinated column. Every such chart was silently dropped.
 */
describe('derivedFields', () => {
  it('collects a calculate transform output', () => {
    const spec = {
      transform: [{ calculate: 'datum.revenue / 1000', as: 'k_revenue' }],
      mark: 'bar',
      encoding: { y: { field: 'k_revenue' } },
    }
    expect([...derivedFields(spec)]).toContain('k_revenue')
  })

  it('collects nested aggregate and window outputs', () => {
    const spec = {
      transform: [
        { aggregate: [{ op: 'sum', field: 'revenue', as: 'total' }], groupby: ['month'] },
        { window: [{ op: 'rank', as: 'position' }] },
      ],
    }
    const found = derivedFields(spec)
    expect(found.has('total')).toBe(true)
    expect(found.has('position')).toBe(true)
  })

  it('knows the names a fold invents when `as` is omitted', () => {
    const found = derivedFields({ transform: [{ fold: ['revenue'] }] })
    expect(found.has('key')).toBe(true)
    expect(found.has('value')).toBe(true)
  })

  it('collects an array-valued `as`', () => {
    const found = derivedFields({ transform: [{ fold: ['a'], as: ['name', 'amount'] }] })
    expect(found.has('name')).toBe(true)
    expect(found.has('amount')).toBe(true)
  })
})

describe('toChartSpec — transform-derived fields', () => {
  it('keeps a chart whose field comes from a calculate transform', () => {
    const spec = {
      transform: [{ calculate: 'datum.revenue * 2', as: 'doubled' }],
      mark: 'bar',
      encoding: { x: { field: 'month' }, y: { field: 'doubled' } },
    }
    expect(toChartSpec(spec, result)).not.toBeNull()
  })

  it('still rejects a field that is neither a column nor a transform output', () => {
    const spec = {
      transform: [{ calculate: 'datum.revenue * 2', as: 'doubled' }],
      mark: 'bar',
      encoding: { x: { field: 'month' }, y: { field: 'invented' } },
    }
    expect(toChartSpec(spec, result)).toBeNull()
  })

  it('skips the field check for a pivot, whose output names come from the data', () => {
    const spec = {
      transform: [{ pivot: 'month', value: 'revenue' }],
      mark: 'bar',
      encoding: { x: { field: '2025-03' } },
    }
    expect(toChartSpec(spec, result)).not.toBeNull()
  })
})
