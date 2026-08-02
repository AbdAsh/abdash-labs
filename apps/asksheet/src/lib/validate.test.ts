import { describe, expect, it } from 'vitest'
import { assertSingleSelect, UnsafeSqlError } from './validate'

const bad = [
  'PRAGMA database_list',
  "COPY data TO '/tmp/x.csv'",
  "ATTACH 'x.db' AS y",
  'select 1; drop table data',
  'INSTALL httpfs',
  'delete from data',
]

const good = [
  'select * from data',
  'SELECT a, b FROM data WHERE x > 1 ORDER BY a',
  'with t as (select 1 as n) select n from t',
  'select * from data;', // single trailing semicolon is fine
]

describe('assertSingleSelect', () => {
  for (const sql of bad) {
    it(`rejects: ${sql}`, () => {
      expect(() => assertSingleSelect(sql)).toThrow(UnsafeSqlError)
    })
  }

  for (const sql of good) {
    it(`accepts: ${sql}`, () => {
      expect(() => assertSingleSelect(sql)).not.toThrow()
    })
  }

  // --- the CTE case, expanded ------------------------------------------------
  // A naive "must start with select" guard would reject every one of these, and
  // the planner produces them constantly.

  const cteQueries = [
    'WITH monthly AS (SELECT month, sum(revenue_usd) AS r FROM data GROUP BY month) SELECT * FROM monthly',
    `with recursive n(i) as (select 1 union all select i + 1 from n where i < 5) select i from n`,
    `
    -- monthly totals, then the outlier
    WITH monthly AS (
      SELECT month, sum(revenue_usd) AS revenue FROM data GROUP BY 1
    ), stats AS (
      SELECT avg(revenue) AS mu, stddev_pop(revenue) AS sigma FROM monthly
    )
    SELECT m.month, m.revenue, (m.revenue - s.mu) / nullif(s.sigma, 0) AS z
    FROM monthly m CROSS JOIN stats s
    ORDER BY z DESC;
    `,
  ]

  for (const [i, sql] of cteQueries.entries()) {
    it(`accepts CTE query #${i + 1}`, () => {
      expect(() => assertSingleSelect(sql)).not.toThrow()
    })
  }

  // --- literal and comment handling -----------------------------------------

  it('ignores forbidden words that appear inside a string literal', () => {
    expect(() =>
      assertSingleSelect("select * from data where note = 'drop table data; attach x'"),
    ).not.toThrow()
  })

  it('ignores a semicolon inside a string literal', () => {
    expect(() => assertSingleSelect("select * from data where s = 'a;b'")).not.toThrow()
  })

  it('handles a doubled quote escape inside a literal', () => {
    expect(() => assertSingleSelect("select * from data where s = 'it''s; drop'")).not.toThrow()
  })

  it('ignores a forbidden word inside a line comment', () => {
    expect(() => assertSingleSelect('select 1 -- drop table data\n')).not.toThrow()
  })

  it('ignores a forbidden word inside a block comment', () => {
    expect(() => assertSingleSelect('select /* delete from data */ 1')).not.toThrow()
  })

  it('rejects a statement hidden after a line comment on the next line', () => {
    expect(() => assertSingleSelect('select 1 -- ok\n; drop table data')).toThrow(UnsafeSqlError)
  })

  it('does not treat a quoted identifier as a keyword', () => {
    expect(() => assertSingleSelect('select "drop" from data')).not.toThrow()
  })

  // --- word-boundary false positives ----------------------------------------

  const columnNamesThatLookDangerous = [
    'select deleted_at, updated_at, inserted_by from data',
    'select download_count, total_exports, dropoff_rate from data',
    'select payload, offset_days, createdon from data',
    'select replace(name, %s, %r) as clean from data'.replace('%s', "'a'").replace('%r', "'b'"),
  ]

  for (const sql of columnNamesThatLookDangerous) {
    it(`accepts benign identifiers: ${sql.slice(0, 48)}…`, () => {
      expect(() => assertSingleSelect(sql)).not.toThrow()
    })
  }

  // --- more hostile shapes ---------------------------------------------------

  const alsoBad: [string, string][] = [
    ['empty string', '   '],
    ['comment only', '-- nothing here'],
    ['create table', 'create table t as select 1'],
    ['create view', 'CREATE VIEW v AS SELECT 1'],
    ['insert', 'insert into data values (1)'],
    ['update', 'update data set a = 1'],
    ['alter', 'alter table data add column x int'],
    ['load extension', 'LOAD spatial'],
    ['export database', "EXPORT DATABASE '/tmp/out'"],
    ['detach', 'DETACH y'],
    ['call', 'CALL pragma_table_info(%q)'.replace('%q', "'data'")],
    ['set variable', 'SET memory_limit = %v'.replace('%v', "'1GB'")],
    ['checkpoint', 'CHECKPOINT'],
    ['leading explain', 'explain select 1'],
    ['two selects', 'select 1; select 2'],
    ['double semicolon', 'select 1;;'],
    ['trailing statement after semicolon and whitespace', 'select 1 ;  copy data to %p'.replace('%p', "'x'")],
    ['unterminated literal hiding a statement', "select * from data where s = 'x"],
    ['nested block comment escape', 'select 1 /* */ ; pragma version'],
  ]

  for (const [label, sql] of alsoBad) {
    it(`rejects ${label}`, () => {
      expect(() => assertSingleSelect(sql)).toThrow(UnsafeSqlError)
    })
  }

  // --- the privacy backstop: nothing may read from outside the tab -----------

  const fileFunctions = [
    "select * from read_csv('https://evil.example/x.csv')",
    "select * from read_csv_auto('/etc/passwd')",
    "select * from read_parquet('s3://bucket/x.parquet')",
    "select * from glob('*')",
    "with t as (select * from read_json('https://evil.example/x')) select * from t",
  ]

  for (const sql of fileFunctions) {
    it(`rejects an outside read: ${sql.slice(0, 44)}…`, () => {
      expect(() => assertSingleSelect(sql)).toThrow(UnsafeSqlError)
    })
  }

  it('rejects an absurdly long statement', () => {
    expect(() => assertSingleSelect(`select ${'a,'.repeat(20_000)} 1 from data`)).toThrow(
      UnsafeSqlError,
    )
  })

  it('names the offending construct in the error message', () => {
    expect(() => assertSingleSelect('drop table data')).toThrow(/drop/i)
  })

  it('throws an UnsafeSqlError, not a bare Error', () => {
    try {
      assertSingleSelect('pragma version')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeSqlError)
      expect((error as UnsafeSqlError).name).toBe('UnsafeSqlError')
    }
  })
})
