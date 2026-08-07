import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootNodeDuck } from '../../test/nodeDuck'
import {
  attachDuck,
  FileTooLargeError,
  MAX_FILE_BYTES,
  MAX_RESULT_ROWS,
  overrideColumnType,
  QueryTimeoutError,
  registerCsv,
  resetDuck,
  runQuery,
} from './duck'
import { preflightCsv } from './csv'
import { findSample } from '../samples'
import { buildProfile, disclosedTokens, MAX_SAMPLES, redactSqlError } from './profile'

/**
 * A real DuckDB, on real bytes.
 *
 * The browser bootstrap in `initDuck()` fetches the single-threaded bundle from
 * jsDelivr and wraps the worker in a blob shim; neither works under Node, so
 * `test/nodeDuck.ts` builds an equivalent Node-flavoured database and this
 * attaches it. Everything below that line — CSV registration, type inference,
 * the timeout, the row cap, the type override, and `buildProfile` against a
 * genuine engine — is the real code path.
 *
 * The same boot is what `scripts/capture-example.mjs` uses to profile the
 * bundled sample before sending that profile to the live planner, which is why
 * it lives in its own module rather than here.
 */

const CSV = `month,region,revenue_usd,is_enterprise,signed_on
2025-01,NA,1200.50,true,2025-01-14
2025-01,EMEA,880.00,false,2025-01-19
2025-02,NA,1310.25,true,2025-02-03
2025-02,EMEA,905.75,false,2025-02-11
2025-03,NA,9820.00,true,2025-03-07
2025-03,EMEA,940.10,false,2025-03-22
`

const RAGGED = `a,b,c
1,2,3
4,5
6,7,8,9
`

describe('duck', () => {
  beforeAll(async () => {
    attachDuck(await bootNodeDuck())
  }, 120_000)

  afterAll(async () => {
    await resetDuck()
  })

  it('infers a sensible type per column', async () => {
    const columns = await registerCsv(CSV, 'data')
    const byName = Object.fromEntries(columns.map((c) => [c.name, c.type]))
    expect(Object.keys(byName)).toEqual([
      'month',
      'region',
      'revenue_usd',
      'is_enterprise',
      'signed_on',
    ])
    expect(byName.revenue_usd).toMatch(/DOUBLE|DECIMAL|FLOAT/i)
    expect(byName.is_enterprise).toMatch(/BOOLEAN/i)
    expect(byName.signed_on).toMatch(/DATE/i)
    expect(byName.region).toMatch(/VARCHAR/i)
  })

  it('counts the rows it loaded', async () => {
    await registerCsv(CSV, 'data')
    const result = await runQuery('select count(*) as n from data')
    expect(result.rows[0]![0]).toBe(6)
  })

  it('returns BIGINT counts as JavaScript numbers, not BigInt', async () => {
    await registerCsv(CSV, 'data')
    const result = await runQuery('select count(*) as n from data')
    expect(typeof result.rows[0]![0]).toBe('number')
  })

  it('answers the outlier question the product is built around', async () => {
    await registerCsv(CSV, 'data')
    const result = await runQuery(
      `with monthly as (select month, sum(revenue_usd) as revenue from data group by 1)
       select month, revenue from monthly order by revenue desc limit 1`,
    )
    expect(result.rows[0]![0]).toBe('2025-03')
  })

  it('reports elapsed milliseconds', async () => {
    await registerCsv(CSV, 'data')
    const result = await runQuery('select 1')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.elapsedMs)).toBe(true)
  })

  it('caps the result at the display row limit and says so', async () => {
    const result = await runQuery(`select i from range(0, ${MAX_RESULT_ROWS + 500}) t(i)`)
    expect(result.rows).toHaveLength(MAX_RESULT_ROWS)
    expect(result.truncated).toBe(true)
  })

  it('does not flag a small result as truncated', async () => {
    await registerCsv(CSV, 'data')
    const result = await runQuery('select * from data')
    expect(result.truncated).toBe(false)
    expect(result.rows).toHaveLength(6)
  })

  it('rejects a deliberately slow query with a timeout rather than hanging', async () => {
    await expect(
      runQuery('select count(*) from range(0, 400000000) a, range(0, 40) b', 100),
    ).rejects.toBeInstanceOf(QueryTimeoutError)
  }, 60_000)

  it('stays usable after a query times out', async () => {
    await runQuery('select count(*) from range(0, 400000000) a, range(0, 40) b', 100).catch(
      () => undefined,
    )
    const result = await runQuery('select 42 as n')
    expect(result.rows[0]![0]).toBe(42)
  }, 60_000)

  it('surfaces a DuckDB binder error instead of returning an empty table', async () => {
    await registerCsv(CSV, 'data')
    await expect(runQuery('select no_such_column from data')).rejects.toThrow(/no_such_column/i)
  })

  it('re-registering replaces the previous file rather than appending to it', async () => {
    await registerCsv(CSV, 'data')
    await registerCsv('month,region,revenue_usd\n2026-01,NA,1\n', 'data')
    const result = await runQuery('select count(*) as n from data')
    expect(result.rows[0]![0]).toBe(1)
  })

  /**
   * This pair is the justification for running PapaParse before DuckDB.
   *
   * DuckDB does not reject a ragged file. It widens to the longest row, throws
   * the header away, and names the columns `column0…column3` — a load that
   * "succeeds" into nonsense, which is worse than an error because the user then
   * asks questions of it. The preflight is what turns that into a sentence.
   */
  it('shows that DuckDB accepts a ragged CSV and quietly mangles it', async () => {
    const columns = await registerCsv(RAGGED, 'ragged')
    expect(columns.map((c) => c.name)).toEqual(['column0', 'column1', 'column2', 'column3'])
    expect(columns.map((c) => c.name)).not.toContain('a')
  })

  it('catches that same ragged CSV in the preflight, before DuckDB sees it', async () => {
    const { problem } = await preflightCsv(RAGGED)
    expect(problem).toMatch(/rows have/i)
    expect(problem).toMatch(/line/i)
  })

  it('re-types a column through overrideColumnType', async () => {
    await registerCsv('a,b\n1,2\n3,4\n', 'typed')
    await overrideColumnType('typed', 'a', 'VARCHAR')
    const described = await runQuery('describe typed')
    const nameIndex = described.columns.findIndex((c) => c.name === 'column_name')
    const typeIndex = described.columns.findIndex((c) => c.name === 'column_type')
    const row = described.rows.find((r) => r[nameIndex] === 'a')!
    expect(String(row[typeIndex])).toMatch(/VARCHAR/i)
  })

  it('turns an uncastable cell into NULL rather than aborting the correction', async () => {
    await registerCsv('a\n1\nnot-a-number\n', 'loose')
    await overrideColumnType('loose', 'a', 'INTEGER')
    const result = await runQuery('select count(a) as n from loose')
    expect(result.rows[0]![0]).toBe(1)
  })

  it('refuses a type that is not on the allowlist', async () => {
    await registerCsv('a\n1\n', 'guarded')
    await expect(overrideColumnType('guarded', 'a', 'VARCHAR); drop table guarded --')).rejects.toThrow()
  })

  it('builds a profile from a real engine with real samples', async () => {
    await registerCsv(CSV, 'data')
    const profile = await buildProfile('data', false, runQuery)

    expect(Object.keys(profile).sort()).toEqual(['columns', 'rowCount', 'table'])
    expect(profile.rowCount).toBe(6)
    expect(profile.columns.map((c) => c.name)).toContain('revenue_usd')
    const region = profile.columns.find((c) => c.name === 'region')!
    expect(region.samples.sort()).toEqual(['EMEA', 'NA'])
    expect(region.samples.length).toBeLessThanOrEqual(5)
  })

  it('sends no sample values at all in strict mode, against a real engine', async () => {
    await registerCsv(CSV, 'data')
    const profile = await buildProfile('data', true, runQuery)
    expect(profile.columns.every((c) => c.samples.length === 0)).toBe(true)
    expect(profile.rowCount).toBe(6)
    // The one assertion that matters: no cell value appears anywhere in the payload.
    expect(JSON.stringify(profile)).not.toContain('9820')
    expect(JSON.stringify(profile)).not.toContain('EMEA')
  })

  /**
   * A regression test for a real defect, found by reading the payload in
   * DevTools rather than by reasoning about it.
   *
   * Sampling each column with a bare `limit 5` returned values in insertion
   * order, so the k-th sample of every column came from the same source row and
   * the first five records of the bundled sample were reconstructible verbatim
   * from the outbound request — while every existing unit test passed, because
   * each individual value was legitimately disclosed. `order by 1` in the sample
   * query sorts each column independently and breaks the alignment.
   *
   * This asserts the property that actually matters: not "how many values are
   * sent" but "how many rows can be rebuilt from them".
   */
  it('emits samples from which no complete source row can be reconstructed', async () => {
    const csv = findSample('saas-revenue')!.csv
    await registerCsv(csv, 'revenue')
    const profile = await buildProfile('revenue', false, runQuery)

    const lines = csv.trim().split('\n')
    const sourceRows = lines.slice(1).map((line) => line.split(','))
    const sampleSets = profile.columns.map((column) => new Set(column.samples))

    const reconstructible = sourceRows.filter((row) =>
      row.every((value, index) => sampleSets[index]?.has(value)),
    )
    expect(reconstructible).toHaveLength(0)
  })

  it('handles a column name containing a double quote', async () => {
    await registerCsv('"we""ird",b\n1,2\n', 'quoted')
    const profile = await buildProfile('quoted', false, runQuery)
    expect(profile.columns.map((c) => c.name)).toContain('we"ird')
  })

  /**
   * The sibling of the row-reconstruction test above, guarding the *second* thing
   * the sample ordering has to avoid.
   *
   * `order by 1` broke the row alignment but replaced it with an order statistic:
   * the five lowest values of every column. For a salary or a date column that is
   * a more sensitive disclosure than five arbitrary values, and "up to five
   * example values" does not describe it. Hashing avoids both.
   */
  it('does not emit the five smallest values of a column', async () => {
    const csv = findSample('saas-revenue')!.csv
    await registerCsv(csv, 'revenue')
    const profile = await buildProfile('revenue', false, runQuery)

    const month = profile.columns.find((c) => c.name === 'month')!
    expect(month.samples.length).toBe(5)

    const lines = csv.trim().split('\n').slice(1)
    const distinct = [...new Set(lines.map((line) => line.split(',')[0]!))].sort()
    expect(distinct.length).toBeGreaterThan(MAX_SAMPLES)

    // Not the bottom of the distribution (`order by 1`) and not the top
    // (`order by 1 desc`). An individual extreme may still be picked — hashing
    // promises that the choice is uncorrelated with value order, not that the
    // minimum is withheld — but the *set* of extremes must not be what is sent.
    const sorted = [...month.samples].sort()
    expect(sorted).not.toEqual(distinct.slice(0, MAX_SAMPLES))
    expect(sorted).not.toEqual(distinct.slice(-MAX_SAMPLES))
  })

  /**
   * The leak this revision was sent to find, proved against the real engine
   * rather than against a hand-written error string.
   */
  it('produces a repair error, from a real conversion failure, with no cell in it', async () => {
    const csv = 'patient,ssn,amount\nA. Kowalski,111-22-3333,not-a-number\nB. Tran,444-55-6666,120\n'
    await registerCsv(csv, 'clinical')
    const profile = await buildProfile('clinical', true, runQuery)
    const sql = 'select cast(ssn as integer) as n from clinical'

    const thrown = await runQuery(sql).then(
      () => null,
      (error: unknown) => error as Error,
    )
    expect(thrown).not.toBeNull()
    // What DuckDB actually said, before anything touched it.
    expect(thrown!.message).toContain('111-22-3333')

    const outbound = redactSqlError(thrown!.message, disclosedTokens(profile, sql))
    expect(outbound).not.toContain('111-22-3333')
    expect(outbound).not.toContain('444-55-6666')
    expect(outbound).not.toContain('Kowalski')
    // And it is still worth sending.
    expect(outbound).toMatch(/conversion error/i)
    expect(outbound).toContain('ssn')
  })

  it('runs a statement the planner terminated with a semicolon', async () => {
    await registerCsv(CSV, 'data')
    // Legal per assertSingleSelect, and a parser error inside the row-cap wrapper
    // until it was stripped — so a good query died and burned the repair retry.
    const result = await runQuery('select month from data;')
    expect(result.rows.length).toBe(6)
  })

  it('still pushes the row cap down through a leading comment', async () => {
    const commented = await runQuery('-- rank them\nselect i from range(0, 9000) t(i)', 20_000, 100)
    expect(commented.rows).toHaveLength(100)
    expect(commented.truncated).toBe(true)
  })

  it('refuses an oversized file before downloading an engine to refuse it with', async () => {
    const huge = { size: MAX_FILE_BYTES + 1, name: 'huge.csv' } as unknown as File
    await expect(registerCsv(huge, 'huge')).rejects.toBeInstanceOf(FileTooLargeError)
    await expect(registerCsv(huge, 'huge')).rejects.toThrow(/MB/)
  })
})
