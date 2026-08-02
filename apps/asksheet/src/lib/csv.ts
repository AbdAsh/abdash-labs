import Papa from 'papaparse'
import { describeCsvProblem, type CsvIssue, type CsvPreflight } from './csvErrors'

/**
 * PapaParse runs *before* DuckDB, and only to produce a good error message.
 *
 * DuckDB still does the real load — it is faster and its type inference is the
 * point of using it. But when a file is ragged or mis-delimited, DuckDB says
 * "Value with unterminated quote found at line 0" and PapaParse can say which
 * row and why. See `csvErrors.ts` for the translation.
 */

/** Rows examined during the preflight. Enough to catch structure problems. */
const PREVIEW_ROWS = 400

export interface PreflightResult {
  /** A human-readable problem, or null when the file looks loadable. */
  problem: string | null
  /** Column names as the preview saw them. */
  fields: string[]
  delimiter: string
}

function toIssues(errors: Papa.ParseError[]): CsvIssue[] {
  return errors.map((error) => ({
    type: error.type,
    code: error.code,
    message: error.message,
    row: error.row,
  }))
}

export async function preflightCsv(input: File | string): Promise<PreflightResult> {
  const result = await new Promise<Papa.ParseResult<Record<string, unknown>>>((resolve, reject) => {
    const config: Papa.ParseConfig<Record<string, unknown>> = {
      header: true,
      preview: PREVIEW_ROWS,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
    }
    if (typeof input === 'string') {
      resolve(Papa.parse<Record<string, unknown>>(input, config))
    } else {
      Papa.parse<Record<string, unknown>>(input, {
        ...config,
        complete: resolve,
        error: reject,
      })
    }
  })

  const preflight: CsvPreflight = {
    issues: toIssues(result.errors ?? []),
    meta: {
      delimiter: result.meta?.delimiter,
      fields: result.meta?.fields ?? [],
      linebreak: result.meta?.linebreak,
    },
    sampledRows: result.data?.length ?? 0,
  }

  return {
    problem: describeCsvProblem(preflight),
    fields: preflight.meta.fields ?? [],
    delimiter: preflight.meta.delimiter ?? ',',
  }
}
