/**
 * A single-SELECT guard for planner-authored SQL.
 *
 * DuckDB-WASM runs in-memory over a local copy, so the worst realistic outcome
 * of a bad statement is a wrong answer rather than damage. This guard exists for
 * the two cases that are not merely wrong:
 *
 *   1. Statements that reach outside the in-memory database — ATTACH, COPY,
 *      INSTALL/LOAD (httpfs), or a file/URL table function. Those are the only
 *      way row data could leave the tab, so they are the privacy thesis's last
 *      line of defence.
 *   2. Pathological statements that hang the tab, which the timeout in `duck.ts`
 *      covers separately.
 *
 * The order matters: literals and comments are removed *before* anything is
 * matched, so `where note = 'drop table data'` is a perfectly good query and
 * `select 1 -- ok` followed by a newline and `; drop table data` is not.
 */

export class UnsafeSqlError extends Error {
  constructor(reason: string) {
    super(`Refused to run this SQL: ${reason}`)
    this.name = 'UnsafeSqlError'
  }
}

/** Longest statement we will even consider. Nothing legitimate comes close. */
const MAX_SQL_LENGTH = 20_000

/**
 * Statement keywords that must never appear. Every one of these is only valid in
 * statement position, and the leading-keyword check below already forbids that —
 * so this list is defence in depth against a parser trick we did not anticipate.
 *
 * Word boundaries do the heavy lifting: `deleted_at`, `updated_at`, `payload`,
 * `dropoff_rate`, `total_exports` and `createdon` all pass, because `_` and
 * trailing letters are word characters. A column whose *entire* name collides
 * with one of these can still be queried — the planner is instructed to quote
 * identifiers, and quoted identifiers are scrubbed before this runs.
 */
const FORBIDDEN_KEYWORD =
  /\b(pragma|copy|attach|detach|install|load|unload|export|import|insert|upsert|update|delete|drop|create|alter|truncate|grant|revoke|vacuum|analyze|checkpoint|call|set|reset|prepare|execute|deallocate)\b/i

/**
 * Table functions that read a path or URL. A planned query always runs against
 * the already-registered table, so any of these is either a mistake or an
 * attempt to pull data in from — or push it out to — somewhere else.
 * The trailing `\w*` catches `read_csv_auto` and friends.
 */
const FORBIDDEN_TABLE_FUNCTION =
  /\b(read_csv|read_parquet|read_json|read_ndjson|read_text|read_blob|read_xlsx|parquet_scan|json_scan|sniff_csv|glob|delta_scan|iceberg_scan)\w*\s*\(/i

const IDENTIFIER_START = /^[a-z_][a-z0-9_]*/i

/**
 * Replaces comments, string literals and quoted identifiers with a placeholder,
 * leaving structure intact. Anything unterminated throws — failing closed on a
 * statement we cannot reason about is the correct outcome.
 *
 * Backslash escapes are deliberately not honoured. DuckDB does not treat `\` as
 * an escape in a standard literal, and mis-scanning an `E'...'` string here ends
 * in an unterminated-literal rejection rather than in a smuggled statement.
 */
function scrub(sql: string): string {
  let out = ''
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      const newline = sql.indexOf('\n', i)
      out += ' '
      i = newline === -1 ? sql.length : newline // keep the newline itself
      continue
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new UnsafeSqlError('unterminated block comment')
      out += ' '
      i = end + 2
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      let closed = false
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2 // doubled quote is an escaped quote
            continue
          }
          j += 1
          closed = true
          break
        }
        j += 1
      }
      if (!closed) {
        throw new UnsafeSqlError(
          ch === "'" ? 'unterminated string literal' : 'unterminated quoted identifier',
        )
      }
      out += ' ? '
      i = j
      continue
    }

    if (ch === '$') {
      const tag = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))
      if (tag) {
        const marker = tag[0]
        const end = sql.indexOf(marker, i + marker.length)
        if (end === -1) throw new UnsafeSqlError('unterminated dollar-quoted string')
        out += ' ? '
        i = end + marker.length
        continue
      }
    }

    out += ch
    i += 1
  }

  return out
}

/**
 * Throws `UnsafeSqlError` unless `sql` is exactly one read-only SELECT (or a
 * `WITH` query, which is the same thing with a preamble — rejecting those would
 * throw away most of what the planner produces).
 */
export function assertSingleSelect(sql: string): void {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new UnsafeSqlError('the statement is empty')
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw new UnsafeSqlError(`the statement is longer than ${MAX_SQL_LENGTH} characters`)
  }

  let body = scrub(sql).trim()
  if (body === '') throw new UnsafeSqlError('the statement is empty')

  // Exactly one optional trailing semicolon is allowed; a second `;` anywhere
  // means a second statement.
  if (body.endsWith(';')) body = body.slice(0, -1).trim()
  if (body === '') throw new UnsafeSqlError('the statement is empty')
  if (body.includes(';')) {
    throw new UnsafeSqlError('only one statement may be run at a time')
  }

  const keywordMatch = FORBIDDEN_KEYWORD.exec(body)
  if (keywordMatch) {
    throw new UnsafeSqlError(`"${keywordMatch[1]}" is not allowed — reads only`)
  }

  const functionMatch = FORBIDDEN_TABLE_FUNCTION.exec(body)
  if (functionMatch) {
    throw new UnsafeSqlError(
      `"${functionMatch[1]}" reads from outside this tab and is not allowed`,
    )
  }

  const first = IDENTIFIER_START.exec(body)?.[0]?.toLowerCase()
  if (first !== 'select' && first !== 'with') {
    throw new UnsafeSqlError(`it must begin with SELECT or WITH, not "${first ?? body.slice(0, 12)}"`)
  }
}

/** Non-throwing form, for UI that wants to explain rather than crash. */
export function checkSingleSelect(sql: string): { ok: true } | { ok: false; reason: string } {
  try {
    assertSingleSelect(sql)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
