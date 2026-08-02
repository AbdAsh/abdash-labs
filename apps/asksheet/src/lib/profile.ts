import { getQueryRunner } from './runtime'
import type { Profile, ProfileColumn, QueryResult, QueryRunner } from './types'

/**
 * THE PRIVACY BOUNDARY.
 *
 * Everything the server is ever told about a user's spreadsheet is produced by
 * `redactProfile` and nowhere else. `buildProfile` is the only caller that talks
 * to DuckDB, and it returns the redacted object rather than the raw one, so there
 * is no code path that hands an un-redacted structure to a network call.
 *
 * `redactProfile` builds a fresh object literal with exactly three keys rather
 * than spreading or deleting from its input. That is the whole trick: a future
 * refactor that adds a field upstream cannot widen the payload, because nothing
 * here copies unknown keys through.
 */

/** Example values per column. Zero in strict mode. */
export const MAX_SAMPLES = 5

/** Characters per sample value. One fat cell must not become an exfiltrated record. */
export const MAX_SAMPLE_LENGTH = 64

/**
 * Above this many columns we stop sampling entirely and send schema only:
 * 5 samples across a very wide sheet would blow the 32 KB request budget the
 * Edge Function enforces, and a rejected request is a worse answer than a
 * schema-only one.
 */
export const MAX_SAMPLED_COLUMNS = 40

function toSampleString(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'bigint') text = value.toString()
  else if (value instanceof Date) text = value.toISOString()
  else if (typeof value === 'object') {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = ''
    }
  } else text = String(value)

  return text.length > MAX_SAMPLE_LENGTH ? `${text.slice(0, MAX_SAMPLE_LENGTH - 1)}…` : text
}

function toColumn(input: unknown, strict: boolean): ProfileColumn | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  if (name === '') return null

  const rawSamples = Array.isArray(record.samples) ? record.samples : []
  // Three keys. No spread, no delete, no dynamic assignment.
  return {
    name,
    type: typeof record.type === 'string' ? record.type : 'UNKNOWN',
    samples: strict ? [] : rawSamples.slice(0, MAX_SAMPLES).map(toSampleString),
  }
}

/**
 * Reduces anything at all to the exact three-key payload the server may see.
 * Invalid input yields the empty profile — this function fails closed, never open.
 */
export function redactProfile(raw: unknown, strict: boolean): Profile {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const rowCount =
    typeof record.rowCount === 'number' && Number.isFinite(record.rowCount) && record.rowCount >= 0
      ? Math.floor(record.rowCount)
      : 0

  const columns = (Array.isArray(record.columns) ? record.columns : [])
    .map((column) => toColumn(column, strict))
    .filter((column): column is ProfileColumn => column !== null)

  return {
    table: typeof record.table === 'string' && record.table !== '' ? record.table : 'data',
    columns,
    rowCount,
  }
}

/** Wraps an identifier for safe interpolation: DuckDB doubles embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function cellAt(result: QueryResult, row: number, column: string): unknown {
  const index = result.columns.findIndex((c) => c.name === column)
  const source = result.rows[row]
  if (!source) return undefined
  return index >= 0 ? source[index] : source[0]
}

/**
 * Reads the schema out of DuckDB and returns the redacted profile.
 *
 * The query runner is injected so this can be exercised without instantiating a
 * WASM database; production callers get the registered DuckDB runner by default.
 */
export async function buildProfile(
  table: string,
  strict: boolean,
  run: QueryRunner = getQueryRunner(),
): Promise<Profile> {
  const ident = quoteIdent(table)

  const described = await run(`describe ${ident}`)
  const columns = described.rows.map((_row, index) => ({
    name: String(cellAt(described, index, 'column_name') ?? ''),
    type: String(cellAt(described, index, 'column_type') ?? 'UNKNOWN'),
  }))

  const counted = await run(`select count(*) as n from ${ident}`)
  const rowCount = Number(cellAt(counted, 0, 'n') ?? 0)

  // Wide sheets go schema-only regardless of the toggle: see MAX_SAMPLED_COLUMNS.
  const skipSamples = strict || columns.length > MAX_SAMPLED_COLUMNS

  const withSamples = await Promise.all(
    columns.map(async (column) => {
      if (skipSamples) return { ...column, samples: [] as unknown[] }
      const col = quoteIdent(column.name)
      try {
        // `order by 1` is a privacy measure, not a cosmetic one. Without it each
        // column's samples come back in insertion order, so the k-th sample of
        // every column belongs to the same source row and the first few records
        // are trivially reconstructible from the payload. Sorting each column
        // independently breaks that alignment: the values are still real, but
        // they no longer line up into rows.
        const sampled = await run(
          `select distinct ${col} as v from ${ident} where ${col} is not null order by 1 limit ${MAX_SAMPLES}`,
        )
        return { ...column, samples: sampled.rows.map((row) => row[0]) }
      } catch {
        // A column DuckDB cannot distinct (nested types, say) simply contributes
        // no examples. A profile with fewer samples still answers most questions.
        return { ...column, samples: [] as unknown[] }
      }
    }),
  )

  // Only the redacted object leaves this function.
  return redactProfile({ table, rowCount, columns: withSamples }, skipSamples)
}
