import type { QueryResult } from './types'

/**
 * Prepares a model-authored Vega-Lite spec for rendering.
 *
 * The LLM emits the spec and the client renders it, so there is no chart-type
 * switch statement to maintain — but that also means the spec is untrusted
 * input. Two things are enforced here: the data is always *our* result set (any
 * `data` the model invented is discarded), and every field it references must
 * actually exist in that result. A spec that fails the field check is dropped
 * and the answer falls back to its table, which is a better outcome than a
 * chart of blanks.
 */

/** Rows the chart layer will accept. Beyond this a table is the honest display. */
export const MAX_CHART_ROWS = 2_000

export function rowsToRecords(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const record: Record<string, unknown> = {}
    result.columns.forEach((column, index) => {
      record[column.name] = row[index]
    })
    return record
  })
}

/** Collects every `field` string anywhere in the spec, at any depth. */
export function referencedFields(spec: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(spec)) {
    for (const item of spec) referencedFields(item, found)
    return found
  }
  if (typeof spec === 'object' && spec !== null) {
    for (const [key, value] of Object.entries(spec)) {
      if (key === 'field' && typeof value === 'string') found.add(value)
      else referencedFields(value, found)
    }
  }
  return found
}

/** Transforms whose output field names come from the *data*, not the spec, so no
 *  static check can know them. `pivot` turns row values into column names. */
const OPAQUE_TRANSFORMS = ['pivot']

/** Vega-Lite transforms that invent field names when `as` is omitted. */
const IMPLICIT_OUTPUTS: Record<string, string[]> = {
  fold: ['key', 'value'],
  density: ['value', 'density'],
  quantile: ['prob', 'value'],
}

/**
 * Field names a transform introduces, which therefore exist at render time even
 * though no SQL column has that name.
 *
 * Without this the field check rejected any spec with a `calculate` or an
 * `aggregate` transform — a perfectly valid chart, silently replaced by its
 * table, because `{"calculate": "datum.a/datum.b", "as": "share"}` followed by
 * `{"y": {"field": "share"}}` looks exactly like a hallucinated column.
 */
export function derivedFields(spec: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(spec)) {
    for (const item of spec) derivedFields(item, found)
    return found
  }
  if (typeof spec === 'object' && spec !== null) {
    const record = spec as Record<string, unknown>
    for (const [key, names] of Object.entries(IMPLICIT_OUTPUTS)) {
      if (key in record) for (const name of names) found.add(name)
    }
    if (typeof record.stack === 'string') {
      found.add(`${record.stack}_start`)
      found.add(`${record.stack}_end`)
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'as') {
        if (typeof value === 'string') found.add(value)
        else if (Array.isArray(value)) {
          for (const name of value) if (typeof name === 'string') found.add(name)
        }
      } else derivedFields(value, found)
    }
  }
  return found
}

function hasOpaqueTransform(spec: Record<string, unknown>): boolean {
  const json = JSON.stringify(spec)
  return OPAQUE_TRANSFORMS.some((name) => json.includes(`"${name}"`))
}

/**
 * Returns a renderable spec, or null when the spec cannot be trusted against
 * this result.
 */
export function toChartSpec(
  spec: Record<string, unknown> | undefined,
  result: QueryResult,
): Record<string, unknown> | null {
  if (!spec || typeof spec !== 'object') return null
  if (result.rows.length === 0 || result.rows.length > MAX_CHART_ROWS) return null

  const referenced = referencedFields(spec)
  if (referenced.size === 0) return null

  if (!hasOpaqueTransform(spec)) {
    const available = new Set(result.columns.map((column) => column.name))
    for (const derived of derivedFields(spec)) available.add(derived)
    for (const field of referenced) {
      // Vega-Lite's aggregate shorthand: {"aggregate": "count"} has no field, but a
      // repeat/datum reference can still name something we do not have.
      if (!available.has(field)) return null
    }
  }

  const { data: _discarded, ...rest } = spec

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    ...rest,
    data: { values: rowsToRecords(result) },
    width: 'container',
    autosize: { type: 'fit-x', contains: 'padding' },
  }
}
