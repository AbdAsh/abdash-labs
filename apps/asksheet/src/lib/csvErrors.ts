/**
 * Turns a parse or engine failure into a sentence a person can act on.
 *
 * "A malformed CSV fails with a helpful message rather than a blank screen" is a
 * stated success criterion, and DuckDB's own errors ("Value with unterminated
 * quote found at line 0") do not clear that bar. PapaParse runs first purely to
 * produce this diagnosis; DuckDB still does the real load.
 *
 * The same standard applies after the file is in: `describeQueryFailure` turns a
 * binder or conversion error into the next thing to try, because a user staring
 * at "Binder Error: Referenced column …" has been told what happened and not what
 * to do about it.
 */

export interface CsvIssue {
  type?: string
  code?: string
  message?: string
  row?: number
}

export interface CsvMeta {
  delimiter?: string
  fields?: string[]
  linebreak?: string
}

export interface CsvPreflight {
  issues: CsvIssue[]
  meta: CsvMeta
  /** Rows PapaParse managed to read in the preview. */
  sampledRows: number
}

const DELIMITER_NAMES: Record<string, string> = {
  ',': 'comma',
  '\t': 'tab',
  ';': 'semicolon',
  '|': 'pipe',
}

function describeDelimiter(delimiter: string | undefined): string {
  if (!delimiter) return 'an unknown delimiter'
  return DELIMITER_NAMES[delimiter] ?? `"${delimiter}"`
}

function duplicates(fields: string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const field of fields) {
    const key = field.trim().toLowerCase()
    if (seen.has(key)) dupes.add(field)
    seen.add(key)
  }
  return [...dupes]
}

/**
 * Returns a human-readable problem, or `null` when the file looks loadable.
 * Only the first real problem is reported — a ragged file produces hundreds of
 * identical errors and listing them helps nobody.
 */
export function describeCsvProblem(preflight: CsvPreflight): string | null {
  const { issues, meta, sampledRows } = preflight
  const fields = meta.fields ?? []

  if (fields.length === 0) {
    return 'This file has no header row. AskSheet needs a first line naming the columns.'
  }

  if (fields.length === 1 && sampledRows > 0) {
    return (
      `Only one column was found, using ${describeDelimiter(meta.delimiter)} as the separator. ` +
      'If this is a semicolon- or tab-separated file, re-export it as a standard CSV.'
    )
  }

  const blank = fields.filter((field) => field.trim() === '').length
  if (blank > 0) {
    return `${blank} column${blank === 1 ? ' has' : 's have'} an empty name in the header row. Give every column a name and try again.`
  }

  const dupes = duplicates(fields)
  if (dupes.length > 0) {
    return `The header repeats ${dupes.map((d) => `"${d}"`).join(', ')}. Column names have to be unique so a query can refer to them.`
  }

  const delimiterIssue = issues.find((issue) => issue.code === 'UndetectableDelimiter')
  if (delimiterIssue) {
    return 'The column separator could not be detected. AskSheet reads comma, tab, semicolon and pipe separated files.'
  }

  const quoteIssue = issues.find(
    (issue) => issue.code === 'MissingQuotes' || issue.code === 'InvalidQuotes',
  )
  if (quoteIssue) {
    const where = typeof quoteIssue.row === 'number' ? ` near line ${quoteIssue.row + 2}` : ''
    return `A quoted value is never closed${where}. Check for a stray " in that row.`
  }

  const ragged = issues.filter(
    (issue) => issue.code === 'TooFewFields' || issue.code === 'TooManyFields',
  )
  if (ragged.length > 0) {
    const first = ragged[0]!
    const line = typeof first.row === 'number' ? first.row + 2 : undefined
    const direction = first.code === 'TooFewFields' ? 'fewer' : 'more'
    const count = ragged.length === 1 ? '1 row has' : `${ragged.length} rows have`
    return (
      `${count} ${direction} values than the ${fields.length} columns in the header` +
      `${line ? `, starting at line ${line}` : ''}. Fix the ragged rows and try again.`
    )
  }

  if (sampledRows === 0) {
    return 'The file has a header but no data rows.'
  }

  return null
}

/**
 * Errors AskSheet raises itself already read as sentences — they were written to
 * be shown. Re-describing them would only make them worse.
 */
const ALREADY_ACTIONABLE = new Set([
  'QueryTimeoutError',
  'FileTooLargeError',
  'EngineUnavailableError',
  'UnsafeSqlError',
  'UnsupportedTypeError',
  'PlanQuotaError',
  'PlanRequestError',
])

function ownMessage(error: unknown): string | null {
  return error instanceof Error && ALREADY_ACTIONABLE.has(error.name) ? error.message : null
}

function raw(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Formats whatever DuckDB threw during load, when the preflight found nothing. */
export function describeLoadFailure(error: unknown): string {
  const own = ownMessage(error)
  if (own) return own

  const text = raw(error)
  if (/unterminated quote/i.test(text)) {
    return 'A quoted value is never closed somewhere in this file. Check for a stray " character.'
  }
  if (/sniffing file|could not detect/i.test(text)) {
    return 'The structure of this file could not be detected. Re-export it as a standard CSV with one header row.'
  }
  if (/conversion error|could not convert/i.test(text)) {
    return `A value did not match its column's inferred type. ${text}`
  }
  if (/out of memory|allocation failure|failed to allocate/i.test(text)) {
    return 'This file needed more memory than the tab has. Nothing was uploaded — try a smaller extract, or drop columns you do not need.'
  }
  return `This file could not be read: ${text}`
}

/**
 * One sentence for a query that failed, actionable where the failure is one the
 * user can do something about.
 *
 * The raw DuckDB text is still shown underneath, because "every answer shows its
 * work" has to hold for the answers that did not arrive either. This is the
 * headline, not a replacement.
 */
export function describeQueryFailure(error: unknown): string {
  const own = ownMessage(error)
  if (own) return own

  const text = raw(error)
  if (/out of memory|allocation failure|failed to allocate/i.test(text)) {
    return 'That query needed more memory than this tab has. Ask for a summary or a top-N rather than every row, and it should fit.'
  }
  if (/referenced column|not found in FROM clause|catalog error/i.test(text)) {
    return 'The planner wrote SQL against a column this sheet does not have. Rephrasing the question using the column names in the schema above usually fixes it.'
  }
  if (/conversion error|could not convert|could not parse|invalid input/i.test(text)) {
    return 'A value would not convert to the type the query needed — text in a number column, most often. Click that column in the schema above and set its type, then ask again.'
  }
  if (/parser error|syntax error/i.test(text)) {
    return 'The planner produced SQL DuckDB could not parse. Asking the same thing in fewer clauses usually gets a simpler query.'
  }
  if (/binder error|no function matches/i.test(text)) {
    return 'The planner used the columns in a way DuckDB rejected. Naming the column you mean in the question usually resolves it.'
  }
  return 'That question could not be answered against this sheet.'
}
