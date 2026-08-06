import { describe, expect, it, vi } from 'vitest'
import {
  buildProfile,
  disclosedTokens,
  MAX_ERROR_LENGTH,
  MAX_SAMPLED_COLUMNS,
  MAX_SAMPLE_LENGTH,
  MAX_SAMPLES,
  redactProfile,
  redactSqlError,
  SAMPLE_SCAN_ROWS,
  SAMPLE_TIMEOUT_MS,
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

/**
 * The second privacy boundary, and the one that was open.
 *
 * Every message below is real output from the bundled DuckDB, captured by running
 * the query against a table containing those cells. `error.message` used to be
 * forwarded verbatim on the repair round-trip, so a failed cast shipped the exact
 * cell the contract says never leaves — inside a payload whose shape and key count
 * were precisely as promised, which is why no existing test noticed.
 */
describe('redactSqlError', () => {
  const profile = redactProfile(
    {
      table: 'data',
      rowCount: 2,
      columns: [
        { name: 'patient', type: 'VARCHAR', samples: [] },
        { name: 'ssn', type: 'VARCHAR', samples: [] },
        { name: 'note', type: 'VARCHAR', samples: [] },
        { name: 'amount', type: 'VARCHAR', samples: [] },
      ],
    },
    true,
  )
  const allowed = disclosedTokens(profile, 'select cast(ssn as integer) from data')

  it('strips the cell value out of a conversion error', () => {
    const real =
      "Conversion Error: Could not convert string '111-22-3333' to INT32 when casting from source column ssn\n\nLINE 2: select cast(ssn as integer) from data\n               ^"
    const out = redactSqlError(real, allowed)
    expect(out).not.toContain('111-22-3333')
    // …while keeping every part the planner needs to write a working retry.
    expect(out).toMatch(/conversion error/i)
    expect(out).toContain('INT32')
    expect(out).toContain('ssn')
  })

  it('strips a cell value DuckDB echoes on its own line under a caret', () => {
    const real =
      'Invalid Input Error: Could not parse string "severe migraine" according to format specifier "%Y-%m-%d"\nsevere migraine\n^\nError: Expected a number'
    const out = redactSqlError(real, allowed)
    expect(out).not.toContain('severe migraine')
    expect(out).toMatch(/invalid input error/i)
  })

  it('strips a date cell out of an invalid-format error', () => {
    const real =
      'Conversion Error: invalid date field format: "Alice Kowalski", expected format is (YYYY-MM-DD) when casting from source column patient'
    const out = redactSqlError(real, allowed)
    expect(out).not.toContain('Alice Kowalski')
    expect(out).toContain('patient')
    expect(out).toContain('YYYY-MM-DD')
  })

  it('keeps column names, because the planner cannot repair a query without them', () => {
    const real =
      'Binder Error: Referenced column "nosuchcol" not found in FROM clause!\nCandidate bindings: "note", "amount"'
    const out = redactSqlError(real, allowed)
    expect(out).toContain('note')
    expect(out).toContain('amount')
    expect(out).toMatch(/binder error/i)
  })

  it('allowlists rather than denylists — an unrecognised quoted token is assumed to be a cell', () => {
    const out = redactSqlError(`Some Error: value 'wholly-unexpected-shape' is bad`, allowed)
    expect(out).not.toContain('wholly-unexpected-shape')
  })

  it('drops the SQL echo, which is already being sent as repair.sql', () => {
    const out = redactSqlError(
      'Binder Error: something\n\nLINE 2: select secret_literal from data\n               ^',
      allowed,
    )
    expect(out).not.toContain('secret_literal')
  })

  it('scrubs an unquoted numeric cell, which conversion errors also produce', () => {
    const out = redactSqlError(
      'Conversion Error: Type INT64 with value 987654321098 can\'t be cast to INT32',
      allowed,
    )
    expect(out).not.toContain('987654321098')
    // Type names glued to their digits are not values and must survive.
    expect(out).toContain('INT64')
    expect(out).toContain('INT32')
  })

  it('does not mangle digits inside an allowlisted column name', () => {
    const named = redactProfile(
      { table: 'data', rowCount: 1, columns: [{ name: 'q1 2024 revenue', type: 'DOUBLE', samples: [] }] },
      true,
    )
    const out = redactSqlError(
      'Binder Error: Referenced column "q1 2024 revenue" not found',
      disclosedTokens(named),
    )
    expect(out).toContain('q1 2024 revenue')
  })

  it('caps the length, because an essay is a place for a value to hide', () => {
    const out = redactSqlError(`Binder Error: ${'padding text '.repeat(200)}`, allowed)
    expect(out.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH)
  })

  it('fails closed on an empty or non-string message', () => {
    expect(redactSqlError('', allowed)).toMatch(/without an error message/i)
    expect(redactSqlError(undefined, allowed)).toMatch(/without an error message/i)
    expect(redactSqlError({ toString: () => "'secret'" }, allowed)).not.toContain('secret')
  })

  it('redacts everything when no vocabulary is supplied at all', () => {
    const out = redactSqlError('Binder Error: column "patient" not found')
    expect(out).not.toContain('patient')
  })
})

describe('disclosedTokens', () => {
  it('covers the table, the column names and the identifiers in the SQL being repaired', () => {
    const profile = redactProfile(
      { table: 'sheet', rowCount: 1, columns: [{ name: 'amount', type: 'DOUBLE', samples: [] }] },
      true,
    )
    const tokens = disclosedTokens(profile, 'select try_cast(amount as int) from sheet')
    expect(tokens.has('sheet')).toBe(true)
    expect(tokens.has('amount')).toBe(true)
    expect(tokens.has('try_cast')).toBe(true)
    expect(tokens.has('never_mentioned')).toBe(false)
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

  /**
   * The ordering of the sample query is load-bearing twice over, and this pins
   * both halves.
   *
   * *Unordered* is the original leak: insertion order makes the k-th sample of
   * every column belong to the same source row, so records reconstruct.
   *
   * *Ordered by value* — `order by 1`, the first fix — breaks that alignment but
   * substitutes a different disclosure: the five lowest salaries, the five
   * earliest dates, the alphabetically first five customers. "Up to five example
   * values" is not a promise to hand over the extremes of every distribution.
   *
   * Hashing is uncorrelated between columns (alignment stays broken) and
   * uncorrelated with the values (no order statistic escapes), so the assertion
   * is both "there is an ORDER BY" and "it is not the ordinal one".
   */
  it('orders samples by a hash, not by insertion order and not by value', async () => {
    const { run, seen } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[42]]),
      'select distinct': result(['v'], [['2025-01']]),
    })
    await buildProfile('data', false, run)
    const sampleQueries = seen.filter((sql) => sql.includes('distinct'))
    expect(sampleQueries.length).toBeGreaterThan(0)
    for (const sql of sampleQueries) {
      const normalised = sql.replace(/\s+/g, ' ').toLowerCase()
      // Never insertion order.
      expect(normalised).toContain('order by')
      // Never value order: `order by 1` and `order by v` both leak the minima.
      expect(normalised).not.toMatch(/order by (1|v)\b/)
      expect(normalised).toContain('order by hash(')
    }
  })

  it('bounds the rows a sample query may scan, so profiling a huge sheet still finishes', async () => {
    const { run, seen } = fakeRunner({
      'describe ': describeResult,
      'count(*)': result(['n'], [[9_000_000]]),
      'select distinct': result(['v'], [['2025-01']]),
    })
    await buildProfile('data', false, run)
    const sampleQueries = seen.filter((sql) => sql.includes('distinct'))
    expect(sampleQueries.length).toBeGreaterThan(0)
    expect(sampleQueries.every((sql) => sql.includes(`limit ${SAMPLE_SCAN_ROWS}`))).toBe(true)
  })

  it('gives sample queries their own shorter timeout rather than the full query budget', async () => {
    const timeouts: (number | undefined)[] = []
    const run = vi.fn(async (sql: string, timeoutMs?: number): Promise<QueryResult> => {
      if (sql.includes('describe ')) return describeResult
      if (sql.includes('count(*)')) return result(['n'], [[42]])
      timeouts.push(timeoutMs)
      return result(['v'], [['x']])
    })
    await buildProfile('data', false, run)
    expect(timeouts.length).toBeGreaterThan(0)
    expect(timeouts.every((ms) => ms === SAMPLE_TIMEOUT_MS)).toBe(true)
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
