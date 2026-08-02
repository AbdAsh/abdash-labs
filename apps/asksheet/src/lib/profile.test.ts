import { describe, expect, it, vi } from 'vitest'
import {
  buildProfile,
  MAX_SAMPLED_COLUMNS,
  MAX_SAMPLE_LENGTH,
  MAX_SAMPLES,
  redactProfile,
} from './profile'
import type { QueryResult } from './types'

const raw = {
  table: 'data',
  rowCount: 5000,
  columns: [
    {
      name: 'email',
      type: 'VARCHAR',
      samples: ['a@b.c', 'd@e.f', 'g@h.i', 'j@k.l', 'm@n.o', 'p@q.r'],
    },
    { name: 'amount', type: 'DOUBLE', samples: ['1', '2', '3'] },
  ],
}

describe('redactProfile', () => {
  it('caps samples at five per column in normal mode', () => {
    const p = redactProfile(raw, false)
    expect(p.columns[0]!.samples).toHaveLength(5)
    expect(MAX_SAMPLES).toBe(5)
  })

  it('removes every sample value in strict mode', () => {
    const p = redactProfile(raw, true)
    expect(p.columns.every((c) => c.samples.length === 0)).toBe(true)
  })

  it('preserves column names, types and row count in strict mode', () => {
    const p = redactProfile(raw, true)
    expect(p.columns.map((c) => c.name)).toEqual(['email', 'amount'])
    expect(p.rowCount).toBe(5000)
  })

  it('never emits a key other than table, rowCount and columns', () => {
    const p = redactProfile({ ...raw, secretRows: [[1, 2]] } as never, false)
    expect(Object.keys(p).sort()).toEqual(['columns', 'rowCount', 'table'])
  })

  // --- hardening beyond the plan's four cases -------------------------------

  it('never emits a key other than name, type and samples on a column', () => {
    const p = redactProfile(
      {
        ...raw,
        columns: [{ name: 'x', type: 'INTEGER', samples: ['1'], rows: [[1], [2]], min: 1 }],
      } as never,
      false,
    )
    expect(Object.keys(p.columns[0]!).sort()).toEqual(['name', 'samples', 'type'])
  })

  it('truncates an oversized sample value so a single fat cell cannot exfiltrate a record', () => {
    const p = redactProfile(
      { ...raw, columns: [{ name: 'notes', type: 'VARCHAR', samples: ['x'.repeat(4000)] }] } as never,
      false,
    )
    expect(p.columns[0]!.samples[0]!.length).toBeLessThanOrEqual(MAX_SAMPLE_LENGTH)
  })

  it('stringifies non-string samples rather than passing objects through', () => {
    const p = redactProfile(
      { ...raw, columns: [{ name: 'j', type: 'JSON', samples: [{ nested: 'secret' }, 7, null] }] } as never,
      false,
    )
    for (const sample of p.columns[0]!.samples) {
      expect(typeof sample).toBe('string')
    }
  })

  it('survives structurally invalid input by emitting the empty profile, never by leaking', () => {
    const p = redactProfile(null as never, false)
    expect(Object.keys(p).sort()).toEqual(['columns', 'rowCount', 'table'])
    expect(p.columns).toEqual([])
    expect(p.rowCount).toBe(0)
  })

  it('produces JSON containing no trace of a rows payload smuggled into the input', () => {
    const p = redactProfile(
      {
        ...raw,
        rows: [['alice@example.com', 91234.56]],
        preview: 'alice@example.com',
      } as never,
      false,
    )
    expect(JSON.stringify(p)).not.toContain('alice@example.com')
    expect(JSON.stringify(p)).not.toContain('91234.56')
  })
})

/** A stub DuckDB that records every statement it is asked to run. */
function fakeRunner(responses: Record<string, QueryResult>) {
  const seen: string[] = []
  const run = vi.fn(async (sql: string): Promise<QueryResult> => {
    seen.push(sql)
    for (const [pattern, result] of Object.entries(responses)) {
      if (sql.includes(pattern)) return result
    }
    return { columns: [], rows: [], elapsedMs: 0, truncated: false }
  })
  return { run, seen }
}

const result = (columns: string[], rows: unknown[][]): QueryResult => ({
  columns: columns.map((name) => ({ name, type: 'VARCHAR' })),
  rows,
  elapsedMs: 1,
  truncated: false,
})

describe('buildProfile', () => {
  const describeResult = result(
    ['column_name', 'column_type'],
    [
      ['month', 'VARCHAR'],
      ['revenue_usd', 'DOUBLE'],
    ],
  )

  it('returns names, types and row count', async () => {
    const { run } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[42]]),
      'select distinct': result(['v'], [['2025-01'], ['2025-02']]),
    })
    const p = await buildProfile('data', false, run)
    expect(p.table).toBe('data')
    expect(p.rowCount).toBe(42)
    expect(p.columns.map((c) => c.name)).toEqual(['month', 'revenue_usd'])
    expect(p.columns.map((c) => c.type)).toEqual(['VARCHAR', 'DOUBLE'])
  })

  it('issues no sample query at all in strict mode', async () => {
    const { run, seen } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[42]]),
    })
    const p = await buildProfile('data', true, run)
    expect(seen.some((sql) => sql.toLowerCase().includes('distinct'))).toBe(false)
    expect(p.columns.every((c) => c.samples.length === 0)).toBe(true)
  })

  it('caps the sample query at MAX_SAMPLES rows', async () => {
    const { run, seen } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[42]]),
      'select distinct': result(['v'], [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]),
    })
    const p = await buildProfile('data', false, run)
    expect(seen.filter((s) => s.includes('distinct')).every((s) => s.includes(`limit ${MAX_SAMPLES}`))).toBe(true)
    expect(p.columns[0]!.samples).toHaveLength(MAX_SAMPLES)
  })

  it('sorts each column independently so samples cannot be re-assembled into rows', async () => {
    const { run, seen } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[42]]),
      'select distinct': result(['v'], [['2025-01']]),
    })
    await buildProfile('data', false, run)
    const sampleQueries = seen.filter((sql) => sql.includes('distinct'))
    expect(sampleQueries.length).toBeGreaterThan(0)
    expect(sampleQueries.every((sql) => sql.includes('order by 1'))).toBe(true)
  })

  it('quotes identifiers so a hostile column name cannot break out of the sample query', async () => {
    const { run, seen } = fakeRunner({
      'describe ': result(['column_name', 'column_type'], [['weird "name', 'VARCHAR']]),
      'count(*)': result(['n'], [[1]]),
      'select distinct': result(['v'], [['x']]),
    })
    await buildProfile('data', false, run)
    const sampleSql = seen.find((s) => s.includes('distinct'))!
    expect(sampleSql).toContain('"weird ""name"')
  })

  it('tolerates a column whose sample query fails and still returns the profile', async () => {
    const run = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('describe ')) return describeResult
      if (sql.includes('count(*)')) return result(['n'], [[3]])
      throw new Error('conversion error')
    })
    const p = await buildProfile('data', false, run)
    expect(p.columns).toHaveLength(2)
    expect(p.columns.every((c) => c.samples.length === 0)).toBe(true)
  })

  it('goes schema-only on a very wide sheet so the payload stays inside the 32 KB budget', async () => {
    const wide = result(
      ['column_name', 'column_type'],
      Array.from({ length: MAX_SAMPLED_COLUMNS + 1 }, (_v, i) => [`c${i}`, 'VARCHAR']),
    )
    const { run, seen } = fakeRunner({ 'describe ': wide, 'count(*)': result(['n'], [[10]]) })
    const p = await buildProfile('data', false, run)
    expect(seen.some((sql) => sql.includes('distinct'))).toBe(false)
    expect(p.columns).toHaveLength(MAX_SAMPLED_COLUMNS + 1)
    expect(p.columns.every((c) => c.samples.length === 0)).toBe(true)
  })

  it('emits only the three contract keys, whatever DuckDB returned', async () => {
    const { run } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[42]]),
      'select distinct': result(['v'], [['2025-01']]),
    })
    const p = await buildProfile('data', false, run)
    expect(Object.keys(p).sort()).toEqual(['columns', 'rowCount', 'table'])
    for (const column of p.columns) {
      expect(Object.keys(column).sort()).toEqual(['name', 'samples', 'type'])
    }
  })
})
