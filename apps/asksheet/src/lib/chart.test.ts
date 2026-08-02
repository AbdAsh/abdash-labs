import { describe, expect, it } from 'vitest'
import { MAX_CHART_ROWS, referencedFields, rowsToRecords, toChartSpec } from './chart'
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
