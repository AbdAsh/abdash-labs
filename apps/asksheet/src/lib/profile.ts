import { getQueryRunner } from './runtime'
import type { Profile, ProfileColumn, QueryResult, QueryRunner } from './types'

/**
 * THE PRIVACY BOUNDARY.
 *
 * Two kinds of thing derived from a user's sheet ever reach the network, and both
 * are produced here and nowhere else:
 *
 *   1. the schema profile, via `redactProfile`;
 *   2. the DuckDB error text on a repair round-trip, via `redactSqlError`.
 *
 * The second one is not obvious and cost us a leak. `buildProfile` is the only
 * caller that talks to DuckDB, and it returns the redacted object rather than the
 * raw one, so there is no code path that hands an un-redacted structure to a
 * network call.
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

/**
 * Rows a sample query is allowed to scan.
 *
 * Sampling used to run an unbounded `select distinct` per column, up to 40 of them
 * concurrently. On a large sheet that is 40 full table scans against a
 * single-threaded engine, every one of them racing the 10 s query timeout — and
 * because a failed sample is swallowed, the visible symptom was a profile that
 * quietly lost its examples on exactly the files where they help most. Bounding
 * the scan makes profiling cost the same on a 200-row sheet and a 2 M-row one.
 */
export const SAMPLE_SCAN_ROWS = 20_000

/** Sample queries get their own, shorter budget: they are a nicety, not the answer. */
export const SAMPLE_TIMEOUT_MS = 5_000

/** Characters of DuckDB error text forwarded on a repair. The planner needs the
 *  diagnosis, not an essay, and every extra character is a place data can hide. */
export const MAX_ERROR_LENGTH = 300

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

/* -------------------------------------------------------------------------- */
/* Error redaction — the second thing that crosses the boundary                */
/* -------------------------------------------------------------------------- */

/**
 * DuckDB puts cell values in its error messages. Verbatim.
 *
 *   Conversion Error: Could not convert string '111-22-3333' to INT32
 *     when casting from source column ssn
 *   Invalid Input Error: Could not parse string "severe migraine"
 *     according to format specifier "%Y-%m-%d"
 *
 * Those are real messages from the bundled engine, and they are not an edge case:
 * the planner is explicitly told to cast text that holds numbers or dates, so a
 * failed cast is the single likeliest reason a repair round-trip happens at all.
 * Forwarding `error.message` therefore ships the exact cells the privacy contract
 * says never leave — in a payload whose shape and key count are precisely as
 * promised.
 *
 * What the planner actually needs to fix its SQL is the error *class* and the
 * construct that failed, not the offending value. So: keep the diagnosis, drop
 * anything that could be a value.
 */

/** Lines DuckDB uses to echo the offending input back, with a caret underneath. */
const CARET_ONLY = /^\s*\^\s*$/
const SQL_ECHO = /^\s*LINE\s+\d+:/i

/** Built per call: a `g` regex carries `lastIndex`, and a shared one across calls
 *  is a class of bug this function must not have. */
const quotedRuns = () => /'[^']*'|"[^"]*"|`[^`]*`/g

/** A bare number of two or more digits, not glued to a word (so INT32 survives). */
const BARE_NUMBER = /(^|[^\w.])(\d[\d,]*(?:\.\d+)?)(?![\w.])/g

function withoutEchoedInput(message: string): string {
  const lines = message.split('\n')
  return lines
    .filter((line, index) => {
      if (CARET_ONLY.test(line)) return false
      if (SQL_ECHO.test(line)) return false
      // DuckDB's convention for pointing at a value is to print it on its own
      // line with a caret under it. That line is the raw cell.
      return !(lines[index + 1] !== undefined && CARET_ONLY.test(lines[index + 1]!))
    })
    .join('\n')
}

function withoutBareNumbers(text: string): string {
  return text.replace(BARE_NUMBER, (whole, prefix: string, digits: string) =>
    digits.replace(/\D/g, '').length >= 2 ? `${prefix}?` : whole,
  )
}

/**
 * Strips anything from a DuckDB error that is not already in the outbound payload.
 *
 * A quoted run survives only if it exactly matches something in `disclosed` —
 * a column name, the table name, or an identifier from the SQL we are sending
 * alongside it. That is an allowlist, not a denylist, which is why it holds for
 * error shapes nobody has seen yet: an unrecognised quoted token is assumed to be
 * a cell, because a cell is the thing it costs the most to be wrong about.
 */
export function redactSqlError(message: unknown, disclosed: Iterable<string> = []): string {
  const raw = typeof message === 'string' ? message : String(message ?? '')
  if (raw.trim() === '') return 'The query failed without an error message.'

  const allowed = new Set<string>()
  for (const token of disclosed) if (token !== '') allowed.add(token)

  let out = ''
  let cursor = 0
  const source = withoutEchoedInput(raw)

  const QUOTED_RUN = quotedRuns()
  for (let match = QUOTED_RUN.exec(source); match; match = QUOTED_RUN.exec(source)) {
    out += withoutBareNumbers(source.slice(cursor, match.index))
    const quote = match[0]![0]!
    const inner = match[0]!.slice(1, -1)
    // Allowlisted identifiers pass through untouched — numbers inside them are
    // part of a name we already sent, not a value.
    out += allowed.has(inner) ? `${quote}${inner}${quote}` : '?'
    cursor = match.index + match[0]!.length
  }
  out += withoutBareNumbers(source.slice(cursor))

  const collapsed = out.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return 'The query failed without an error message.'
  return collapsed.length > MAX_ERROR_LENGTH
    ? `${collapsed.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : collapsed
}

/**
 * Everything already in the outbound payload, and therefore safe to leave in an
 * error message: the table name, the column names, and the identifiers in the SQL
 * being sent for repair. Nothing here is new information to the server.
 */
export function disclosedTokens(profile: Profile, sql = ''): Set<string> {
  const tokens = new Set<string>([profile.table])
  for (const column of profile.columns) tokens.add(column.name)
  for (const word of sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) tokens.add(word)
  return tokens
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
        // Ordering is a privacy measure here, not a cosmetic one, and which
        // ordering matters twice over.
        //
        // Insertion order is the one that must not be used: the k-th sample of
        // every column would then belong to the same source row, and the first
        // few records become reconstructible from the payload. Sorting breaks
        // that alignment.
        //
        // But sorting *by value* — the first fix — quietly discloses an order
        // statistic instead: the five lowest salaries, the five earliest dates,
        // the alphabetically first five customers. "Up to five example values"
        // does not mean "the extremes of every distribution", and the extremes
        // are the values a reader would least expect to have handed over.
        //
        // Hashing gives an ordering that is uncorrelated between columns (so the
        // alignment stays broken), uncorrelated with the values themselves (so no
        // order statistic escapes), and deterministic — which is itself a privacy
        // property: a fresh random sample each turn would disclose new values on
        // every question, so twenty questions would leak far more than five
        // values per column.
        const sampled = await run(
          `select v from (
             select distinct ${col} as v
             from (select ${col} from ${ident} limit ${SAMPLE_SCAN_ROWS})
             where ${col} is not null
           ) order by hash(v) limit ${MAX_SAMPLES}`,
          SAMPLE_TIMEOUT_MS,
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
