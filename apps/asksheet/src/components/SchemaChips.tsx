import { useState } from 'react'
import { SUPPORTED_TYPES } from '../lib/columnTypes'
import type { ColumnInfo } from '../lib/types'

/**
 * Inferred columns as chips, each one clickable to correct its type.
 *
 * Type inference over a CSV is a guess, and the guess is usually right. Showing
 * it up front — rather than after a confusing answer — is what makes it cheap to
 * fix the one column where it is wrong.
 */
export function SchemaChips({
  columns,
  rowCount,
  onOverride,
  busy,
}: {
  columns: ColumnInfo[]
  rowCount: number | null
  onOverride: (column: string, type: string) => void
  busy: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [next, setNext] = useState<string>(SUPPORTED_TYPES[0])

  const current = columns.find((column) => column.name === editing)

  return (
    <section className="panel" aria-labelledby="schema-heading">
      <h2 id="schema-heading">Schema — click a column to change its type</h2>

      <ul className="chips">
        {columns.map((column) => (
          <li key={column.name}>
            <button
              type="button"
              className="chip"
              aria-expanded={editing === column.name}
              disabled={busy}
              onClick={() => {
                setEditing(editing === column.name ? null : column.name)
                setNext(column.type.toUpperCase())
              }}
            >
              <span className="cname">{column.name}</span>
              <span className="ctype">{column.type}</span>
            </button>
          </li>
        ))}
      </ul>

      {current && (
        <div className="chip-editor">
          <label htmlFor="type-select">
            Read <strong>{current.name}</strong> as
          </label>
          <select
            id="type-select"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            disabled={busy}
          >
            {SUPPORTED_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || next === current.type.toUpperCase()}
            onClick={() => {
              onOverride(current.name, next)
              setEditing(null)
            }}
          >
            Apply
          </button>
          <button type="button" className="btn" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <span className="hint" style={{ color: 'var(--ink-faint)', fontSize: '0.78rem' }}>
            Values that will not convert become NULL rather than blocking the change.
          </span>
        </div>
      )}

      {rowCount !== null && (
        <p className="meta-line">
          {rowCount.toLocaleString()} rows · {columns.length} columns · in memory, in this tab
        </p>
      )}
    </section>
  )
}
