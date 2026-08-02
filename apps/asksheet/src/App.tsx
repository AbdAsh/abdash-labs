import { useCallback, useMemo, useRef, useState } from 'react'
import { AnswerCard } from './components/Answer'
import { Dropzone } from './components/Dropzone'
import { PrivacyContract } from './components/PrivacyContract'
import { SchemaChips } from './components/SchemaChips'
import { SqlDisclosure } from './components/SqlDisclosure'
import { preflightCsv } from './lib/csv'
import { describeLoadFailure } from './lib/csvErrors'
import { overrideColumnType, registerCsv, runQuery } from './lib/duck'
import { ask, AskFailedError } from './lib/plan'
import { starterQuestions } from './lib/starters'
import type { Answer, ColumnInfo, PlanHistoryItem } from './lib/types'
import type { Sample } from './samples'

const TABLE = 'data'

interface Turn {
  question: string
  answer: Answer
}

interface AskFailure {
  question: string
  message: string
  attempts: string[]
}

export function App() {
  const [strict, setStrict] = useState(false)
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null)
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [sourceName, setSourceName] = useState<string | null>(null)
  const [sampleQuestions, setSampleQuestions] = useState<string[] | null>(null)

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [failure, setFailure] = useState<AskFailure | null>(null)

  const history = useRef<PlanHistoryItem[]>([])
  const busy = loading || asking

  const load = useCallback(async (input: File | string, name: string, questions?: string[]) => {
    setLoading(true)
    setLoadError(null)
    setFailure(null)
    setTurns([])
    history.current = []

    try {
      // PapaParse first, purely so a broken file gets a sentence instead of a
      // DuckDB internal error. See lib/csvErrors.ts.
      const preflight = await preflightCsv(input)
      if (preflight.problem) {
        setLoadError(preflight.problem)
        setColumns(null)
        return
      }

      const inferred = await registerCsv(input, TABLE)
      const counted = await runQuery(`select count(*) as n from "${TABLE}"`)
      setColumns(inferred)
      setRowCount(Number(counted.rows[0]?.[0] ?? 0))
      setSourceName(name)
      setSampleQuestions(questions ?? null)
    } catch (error) {
      setColumns(null)
      setRowCount(null)
      setLoadError(describeLoadFailure(error))
    } finally {
      setLoading(false)
    }
  }, [])

  const onSample = useCallback(
    (sample: Sample) => void load(sample.csv, sample.name, sample.questions),
    [load],
  )

  const onOverride = useCallback(
    async (column: string, type: string) => {
      setLoading(true)
      setLoadError(null)
      try {
        await overrideColumnType(TABLE, column, type)
        const described = await runQuery(`describe "${TABLE}"`)
        const nameIndex = described.columns.findIndex((c) => c.name === 'column_name')
        const typeIndex = described.columns.findIndex((c) => c.name === 'column_type')
        setColumns(
          described.rows.map((row) => ({
            name: String(row[nameIndex]),
            type: String(row[typeIndex]),
          })),
        )
      } catch (error) {
        setLoadError(describeLoadFailure(error))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '' || busy) return

      setAsking(true)
      setFailure(null)
      try {
        const answer = await ask(trimmed, TABLE, strict, { history: history.current })
        history.current = [...history.current, { question: trimmed, sql: answer.sql }]
        setTurns((previous) => [...previous, { question: trimmed, answer }])
        setQuestion('')
      } catch (error) {
        setFailure({
          question: trimmed,
          message: error instanceof Error ? error.message : String(error),
          attempts: error instanceof AskFailedError ? error.attempts : [],
        })
      } finally {
        setAsking(false)
      }
    },
    [busy, strict],
  )

  const starters = useMemo(
    () => sampleQuestions ?? (columns ? starterQuestions(columns) : []),
    [sampleQuestions, columns],
  )

  return (
    <div className="shell">
      <header className="masthead">
        <h1>AskSheet</h1>
        <p className="tagline">Ask your spreadsheet questions. The answers come from your laptop.</p>
      </header>

      <PrivacyContract strict={strict} onStrictChange={setStrict} locked={asking} />

      <Dropzone onFile={(file) => void load(file, file.name)} onSample={onSample} busy={busy} />

      {loadError && (
        <div className="notice notice-error" role="alert">
          {loadError}
        </div>
      )}

      {loading && (
        <p className="meta-line" aria-live="polite">
          <span className="spinner" /> Loading into DuckDB…
        </p>
      )}

      {columns && (
        <>
          <SchemaChips
            columns={columns}
            rowCount={rowCount}
            onOverride={(column, type) => void onOverride(column, type)}
            busy={busy}
          />

          <section className="panel" aria-labelledby="ask-heading">
            <h2 id="ask-heading">Ask {sourceName ? `about ${sourceName}` : 'a question'}</h2>
            <form
              className="ask"
              onSubmit={(event) => {
                event.preventDefault()
                void submit(question)
              }}
            >
              <label className="visually-hidden" htmlFor="question">
                Your question
              </label>
              <textarea
                id="question"
                value={question}
                rows={2}
                placeholder="Which month had the highest revenue and why is it an outlier?"
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void submit(question)
                  }
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={busy || question.trim() === ''}>
                {asking ? <span className="spinner" /> : 'Ask'}
              </button>
            </form>

            {starters.length > 0 && (
              <div className="starters">
                {starters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    className="starter"
                    disabled={busy}
                    onClick={() => void submit(starter)}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <div aria-live="polite">
        {turns.map((turn, index) => (
          <AnswerCard key={`${index}-${turn.question}`} question={turn.question} answer={turn.answer} />
        ))}

        {asking && (
          <p className="meta-line">
            <span className="spinner" /> Planning the query…
          </p>
        )}

        {failure && (
          <div className="notice notice-error" role="alert">
            <strong>Could not answer “{failure.question}”.</strong>
            <pre>{failure.message}</pre>
            {failure.attempts.map((sql, index) => (
              <SqlDisclosure
                key={sql + String(index)}
                sql={sql}
                label={`Attempt ${index + 1}`}
                defaultOpen={index === failure.attempts.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="meta-line" style={{ marginTop: '2.5rem' }}>
        DuckDB-WASM (single-threaded) · Vega-Lite · planner runs on OpenRouter ·{' '}
        <a href="/">abdash labs</a>
      </footer>
    </div>
  )
}
