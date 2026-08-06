/**
 * Server-side redaction of the DuckDB error text on a repair round-trip.
 *
 * This is the second thing an AskSheet request carries from the user's sheet, and
 * the less obvious one. DuckDB puts the offending cell in its error messages,
 * verbatim:
 *
 *   Conversion Error: Could not convert string '111-22-3333' to INT32
 *     when casting from source column ssn
 *   Invalid Input Error: Could not parse string "severe migraine"
 *     according to format specifier "%Y-%m-%d"
 *
 * Those are real messages from the engine the client ships. They are not an edge
 * case either: the system prompt tells the planner to cast text that holds
 * numbers or dates, so a failed cast is the likeliest reason a repair happens at
 * all — which makes the commonest repair the one that carries a cell.
 *
 * The client redacts this before sending (`apps/asksheet/src/lib/profile.ts`).
 * This module exists for the same reason `sanitizeProfile` does: a server that
 * takes the client's word for a privacy boundary is not enforcing one, and a
 * stale tab is enough to make that matter.
 *
 * It lives in its own file, apart from `index.ts`, so it can be tested without
 * standing up `Deno.serve` — the same split `critiq-review` uses for its SSRF
 * guard.
 */

/** The planner needs the diagnosis, not an essay. Length is where a value hides. */
export const MAX_ERROR_CHARS = 300

const CARET_ONLY = /^\s*\^\s*$/
const SQL_ECHO = /^\s*LINE\s+\d+:/i
const QUOTED_RUN = /'[^']*'|"[^"]*"|`[^`]*`/g

/** A bare number of two or more digits not glued to a word, so `INT32` survives. */
const BARE_NUMBER = /(^|[^\w.])(\d[\d,]*(?:\.\d+)?)(?![\w.])/g

interface ProfileLike {
  table: string
  columns: { name: string }[]
}

/**
 * Drops the lines DuckDB uses to echo input back.
 *
 * Two conventions matter. `LINE 2: <sql>` with a caret under it repeats the
 * statement — redundant, since `repair.sql` carries it exactly. And a bare value
 * printed on its own line with a caret beneath is how DuckDB points at the thing
 * that would not parse; that line *is* the cell, unquoted, so no amount of
 * quote-handling would catch it.
 */
function withoutEchoedInput(message: string): string {
  const lines = message.split('\n')
  const caretOnly = (line: string | undefined) => line !== undefined && CARET_ONLY.test(line)
  return lines
    .filter((line, index) => {
      if (caretOnly(line)) return false
      if (SQL_ECHO.test(line)) return false
      return !caretOnly(lines[index + 1])
    })
    .join('\n')
}

function withoutBareNumbers(text: string): string {
  return text.replace(BARE_NUMBER, (whole, prefix: string, digits: string) =>
    digits.replace(/\D/g, '').length >= 2 ? `${prefix}?` : whole,
  )
}

/**
 * Strips anything from a DuckDB error that is not already elsewhere in the
 * request.
 *
 * A quoted run survives only if it exactly matches something in `disclosed`. That
 * is an allowlist rather than a denylist, which is the whole point: it holds for
 * error shapes nobody has catalogued, because an unrecognised quoted token is
 * assumed to be a cell — a cell being the thing it costs most to be wrong about.
 */
export function redactSqlError(message: unknown, disclosed: Set<string>): string {
  const raw = typeof message === 'string' ? message : String(message ?? '')
  if (raw.trim() === '') return 'The query failed without an error message.'

  const source = withoutEchoedInput(raw)
  let out = ''
  let cursor = 0

  QUOTED_RUN.lastIndex = 0
  for (let match = QUOTED_RUN.exec(source); match; match = QUOTED_RUN.exec(source)) {
    out += withoutBareNumbers(source.slice(cursor, match.index))
    const inner = match[0].slice(1, -1)
    // Allowlisted identifiers pass through whole — digits inside them belong to a
    // name the server already has, not to a value.
    out += disclosed.has(inner) ? match[0] : '?'
    cursor = match.index + match[0].length
  }
  out += withoutBareNumbers(source.slice(cursor))

  const collapsed = out.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return 'The query failed without an error message.'
  return collapsed.length > MAX_ERROR_CHARS ? collapsed.slice(0, MAX_ERROR_CHARS) : collapsed
}

/** Everything already present in this request, and so safe to leave in an error. */
export function disclosedTokens(profile: ProfileLike, sql: string): Set<string> {
  const tokens = new Set<string>([profile.table])
  for (const column of profile.columns) tokens.add(column.name)
  for (const word of sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) tokens.add(word)
  return tokens
}
