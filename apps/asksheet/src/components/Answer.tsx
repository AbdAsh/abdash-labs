import { capturedOn, type ReplayProvenance } from '../example'
import { csvFilename, resultToCsv } from '../lib/exportCsv'
import type { Answer as AnswerData } from '../lib/types'
import { Chart } from './Chart'
import { SqlDisclosure } from './SqlDisclosure'

/** Rows rendered into the DOM. The result itself is capped at 5,000 by `duck.ts`. */
const DISPLAY_ROWS = 200

function isNumeric(type: string): boolean {
  return /INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL|HUGEINT/i.test(type)
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function download(answer: AnswerData, question: string) {
  const blob = new Blob([resultToCsv(answer.result)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = csvFilename(question)
  link.click()
  URL.revokeObjectURL(url)
}

export function AnswerCard({
  question,
  answer,
  replay,
}: {
  question: string
  answer: AnswerData
  /** Present when this answer replayed a saved plan rather than asking the
   *  planner. The card then has to be explicit about which half is which. */
  replay?: ReplayProvenance
}) {
  const { result } = answer
  const shown = result.rows.slice(0, DISPLAY_ROWS)

  return (
    <article className={`answer${replay ? ' is-replay' : ''}`}>
      <p className="question">
        <strong>{question}</strong>
      </p>

      <p className="narration">{answer.narration}</p>

      <div className="badges">
        <span className="badge badge-timing">
          {result.elapsedMs} ms · {replay ? 'computed in this tab just now' : 'in-browser'}
        </span>
        {replay && (
          <span className="badge badge-replay">saved plan · {capturedOn(replay.capturedAt)}</span>
        )}
        {answer.repaired && (
          <span className="badge badge-repaired">
            first query failed — this is the corrected one
          </span>
        )}
        {result.truncated && <span className="badge badge-truncated">result capped at 5,000 rows</span>}
      </div>

      {/* Permanent, not dismissible: the whole point of the example path is that
          a visitor can tell exactly which part of it was recorded. */}
      {replay && (
        <p className="provenance">
          The SQL below was written by the planner on {capturedOn(replay.capturedAt)} and saved with
          this page. Everything above it was computed by DuckDB in this tab a moment ago, from the
          bundled sample — no stored results, and no network request to show you them.
          {replay.followsQuestion && (
            <>
              {' '}
              It was asked as a follow-up to “{replay.followsQuestion}”, and the planner was given
              that question’s SQL as context — never the rows it returned.
            </>
          )}
          {replay.repaired && (
            <> The planner’s first attempt failed when this was recorded; this is its correction.</>
          )}
        </p>
      )}

      <Chart spec={answer.chart} result={result} title={question} />

      {result.rows.length === 0 && (
        <p className="empty">
          No rows matched. The query below ran without error — the sheet simply has nothing that
          fits it. Widen the question, or check the schema for the column you meant.
        </p>
      )}

      <div className="table-scroll">
        <table className="result">
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column.name} scope="col">
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={rowIndex}>
                {row.map((value, columnIndex) => (
                  <td
                    // eslint-disable-next-line react/no-array-index-key
                    key={columnIndex}
                    className={
                      value === null || value === undefined
                        ? 'null'
                        : isNumeric(result.columns[columnIndex]?.type ?? '')
                          ? 'numeric'
                          : undefined
                    }
                  >
                    {cell(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.rows.length > DISPLAY_ROWS && (
        <p className="meta-line">
          Showing the first {DISPLAY_ROWS} of {result.rows.length.toLocaleString()} rows. Download
          the CSV for all of them.
        </p>
      )}

      <SqlDisclosure
        sql={answer.sql}
        label={replay ? `SQL — planned ${capturedOn(replay.capturedAt)}, replayed here` : 'SQL'}
        onDownload={() => download(answer, question)}
      />

      {/* The claim the app is built on, shown rather than described: this is the
          whole payload that produced the statement above, byte for byte. */}
      {replay && (
        <SqlDisclosure
          sql={JSON.stringify(replay.request, null, 2)}
          label={`the ${replay.requestBytes} bytes that were sent to plan it`}
          copyLabel="Copy request"
        />
      )}
    </article>
  )
}
