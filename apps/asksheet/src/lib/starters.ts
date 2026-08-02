import { typeFamily } from './columnTypes'
import type { ColumnInfo } from './types'

/**
 * Three questions derived from the schema alone.
 *
 * An empty prompt box is the most common place a demo like this dies: the
 * visitor does not know what the data contains, so they type nothing and leave.
 * These are generated locally from column names and types — no round-trip, and
 * nothing about the data is consulted to produce them.
 */

const DATE_HINT = /(date|month|day|time|year|created|opened|closed|signed|_at$)/i
const MEASURE_HINT = /(revenue|amount|total|price|cost|value|sales|mrr|arr|spend|count|qty|quantity|hours|minutes|score|rating)/i
const DIMENSION_HINT = /(region|country|city|category|segment|plan|type|status|channel|priority|team|agent|group|source|product|department)/i

function pick(columns: ColumnInfo[], family: string, hint: RegExp): ColumnInfo | undefined {
  const matching = columns.filter((column) => typeFamily(column.type) === family)
  return matching.find((column) => hint.test(column.name)) ?? matching[0]
}

export function starterQuestions(columns: ColumnInfo[]): string[] {
  if (columns.length === 0) return []

  const date =
    columns.find((column) => typeFamily(column.type) === 'date') ??
    columns.find((column) => DATE_HINT.test(column.name))
  const measure = pick(columns, 'number', MEASURE_HINT)
  const dimension =
    columns.filter((column) => typeFamily(column.type) === 'text').find((column) => DIMENSION_HINT.test(column.name)) ??
    columns.find((column) => typeFamily(column.type) === 'text')

  const questions: string[] = []

  if (measure && date) {
    questions.push(`How does ${measure.name} change over ${date.name}?`)
  }
  if (measure && dimension) {
    questions.push(`Total ${measure.name} by ${dimension.name}`)
  }
  if (measure) {
    questions.push(`Which rows have an unusually high ${measure.name}?`)
  }
  if (dimension && questions.length < 3) {
    questions.push(`How many rows are there per ${dimension.name}?`)
  }
  if (questions.length < 3) {
    questions.push('Summarise this table in a few numbers')
  }

  return questions.slice(0, 3)
}
