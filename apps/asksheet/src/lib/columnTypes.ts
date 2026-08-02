/**
 * The types a user may cast a column to from the schema chips.
 *
 * An allowlist rather than a free-text field: the chosen type is interpolated
 * into a `try_cast(... as X)`, and there is no bind parameter for a type name.
 */
export const SUPPORTED_TYPES = [
  'VARCHAR',
  'BOOLEAN',
  'INTEGER',
  'BIGINT',
  'DOUBLE',
  'DECIMAL(18,4)',
  'DATE',
  'TIME',
  'TIMESTAMP',
] as const

export type SupportedType = (typeof SUPPORTED_TYPES)[number]

export class UnsupportedTypeError extends Error {
  constructor(type: string) {
    super(`"${type}" is not a type AskSheet can cast to.`)
    this.name = 'UnsupportedTypeError'
  }
}

export function isSupportedType(type: string): type is SupportedType {
  return (SUPPORTED_TYPES as readonly string[]).includes(type.toUpperCase())
}

/** Returns the canonical (upper-case) form, or throws. */
export function assertSupportedType(type: string): SupportedType {
  const canonical = type.toUpperCase()
  if (!isSupportedType(canonical)) throw new UnsupportedTypeError(type)
  return canonical
}

/**
 * Groups DuckDB's many concrete types into the four buckets the UI cares about,
 * which is all a chart or a starter question needs to know.
 */
export function typeFamily(duckType: string): 'number' | 'date' | 'boolean' | 'text' {
  const t = duckType.toUpperCase()
  if (/^(TINY|SMALL|BIG|HUGE)?INT|^INTEGER|^UINT|^DOUBLE|^FLOAT|^REAL|^DECIMAL|^NUMERIC/.test(t)) {
    return 'number'
  }
  if (/^DATE|^TIMESTAMP|^TIME|^INTERVAL/.test(t)) return 'date'
  if (t.startsWith('BOOL')) return 'boolean'
  return 'text'
}
