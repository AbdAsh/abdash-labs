import type { QueryResult } from './types'

/**
 * Serialises a result table for the download button.
 *
 * Client-side by necessity as much as by principle: the rows only exist in this
 * tab, so there is nothing to ask a server for.
 */
export function resultToCsv(result: QueryResult): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = result.columns.map((column) => escape(column.name)).join(',')
  const body = result.rows.map((row) => row.map(escape).join(',')).join('\n')
  return body === '' ? `${header}\n` : `${header}\n${body}\n`
}

/** A filesystem-safe name derived from the question that produced the table. */
export function csvFilename(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `asksheet-${slug === '' ? 'result' : slug}.csv`
}
