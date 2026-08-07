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
  readOnly = false,
}: {
  columns: ColumnInfo[]
  rowCount: number | null
  onOverride: (column: string, type: string) => void
  busy: boolean
  /** The example path shows the schema but must not let it be changed: its saved
   *  SQL was planned against these exact types, and re-casting a column would
   *  quietly turn a replay into a different query. */
  readOnly?: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [next, setNext] = useState<string>(SUPPORTED_TYPES[0])

  const current = columns.find((column) => column.name === editing)

  // DuckDB names columns `column0…columnN` when its sniffer decides the file has
  // no header row. Worth saying out loud: the column names are the one part of
  // the schema that goes to the planner, so the user should know theirs are
  // placeholders — and that their first row is data, not a heading.
  const headerless =
    columns.length > 0 && columns.every((column) => /^column\d+$/.test(column.name))

  return (
    <section className="panel" aria-labelledby="schema-heading">
      <h2 id="schema-heading">
        {readOnly ? 'Schema' : 'Schema — click a column to change its type'}
      </h2>

      {headerless && (
        <div className="notice notice-warn" role="status">
          This file appears to have no header row, so the columns are named{' '}
          <code>column0</code> onwards and the first line is being treated as data. Questions will
          work, but they will be easier to write against a file with a named header.
        </div>
      )}

      <ul className="chips">
        {columns.map((column) =>
          readOnly ? (
            <li key={column.name}>
              <span className="chip is-static">
                <span className="cname">{column.name}</span>
                <span className="ctype">{column.type}</span>
              </span>
            </li>
          ) : (
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
          ),
        )}
      </ul>

      {!readOnly && current && (
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
