import { linkGitHub, linkGoogle, quotaFor, usedToday, useSession } from '@labs/platform'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnswerCard } from './components/Answer'
import { Dropzone } from './components/Dropzone'
import { PrivacyContract } from './components/PrivacyContract'
import { SchemaChips } from './components/SchemaChips'
import { SqlDisclosure } from './components/SqlDisclosure'
import { preflightCsv } from './lib/csv'
import { describeLoadFailure, describeQueryFailure } from './lib/csvErrors'
import { isEngineReady, overrideColumnType, registerCsv, runQuery, unsupportedReason } from './lib/duck'
import { ask, AskFailedError } from './lib/plan'
import { PlanQuotaError } from './lib/planClient'
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
  /** What to do about it. */
  headline: string
  /** What actually happened. Shown underneath, because the app shows its work. */
  detail: string
  attempts: string[]
  quota: boolean
}

/** "17 of 20 questions left today", and the part people are surprised by. */
function plansLeft(used: number, limit: number | null): string | null {
  if (limit === null) return null
  if (limit <= 0) return 'Daily question limit unavailable.'
  const left = Math.max(0, limit - used)
  return `${left} of ${limit} question${limit === 1 ? '' : 's'} left today — a query that fails and has to be corrected costs two.`
}

export function App() {
  const { session } = useSession()

  const [strict, setStrict] = useState(false)
  const [strictReset, setStrictReset] = useState(false)
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null)
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [sourceName, setSourceName] = useState<string | null>(null)
  const [sampleQuestions, setSampleQuestions] = useState<string[] | null>(null)

  const [loading, setLoading] = useState(false)
  const [loadingNote, setLoadingNote] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [failure, setFailure] = useState<AskFailure | null>(null)

  const [limit, setLimit] = useState<number | null>(null)
  const [used, setUsed] = useState(0)

  const history = useRef<PlanHistoryItem[]>([])
  const busy = loading || asking

  // Feature detection before the dropzone is offered, not after a file is in it:
  // "this browser cannot run a WASM database" and "your CSV is malformed" are
  // different conversations, and finding out late makes the first look like the
  // second. Computed once — nothing here changes during a session.
  const unsupported = useMemo(() => unsupportedReason(), [])

  const refreshQuota = useCallback(async () => {
    const [nextLimit, nextUsed] = await Promise.all([
      quotaFor('asksheet', 'plans'),
      usedToday('asksheet', 'plans'),
    ])
    setLimit(nextLimit)
    setUsed(nextUsed)
  }, [])

  useEffect(() => {
    void refreshQuota().catch(() => undefined)
  }, [refreshQuota])

  const exhausted = limit !== null && limit > 0 && used >= limit
  const remaining = plansLeft(used, limit)

  const load = useCallback(async (input: File | string, name: string, questions?: string[]) => {
    setLoading(true)
    setLoadingNote(
      isEngineReady()
        ? 'Reading the file into DuckDB…'
        : 'Starting DuckDB inside this tab — a few megabytes of WebAssembly, downloaded once…',
    )
    setLoadError(null)
    setFailure(null)
    setStrictReset(false)
    setTurns([])
    history.current = []

    try {
      // PapaParse first, purely so a broken file gets a sentence instead of a
      // DuckDB internal error. See lib/csvErrors.ts.
      const preflight = await preflightCsv(input)
      if (preflight.problem) {
        setLoadError(preflight.problem)
        setColumns(null)
        setRowCount(null)
        setSourceName(null)
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
      setSourceName(null)
      setLoadError(describeLoadFailure(error))
    } finally {
      setLoading(false)
    }
  }, [])

  const onSample = useCallback(
    (sample: Sample) => void load(sample.csv, sample.name, sample.questions),
    [load],
  )

  /**
   * Turning strict mode on has to clear the conversation.
   *
   * Strict mode promises the server sees names and types and nothing else. But
   * follow-ups carry the SQL of earlier turns, and that SQL contains literals —
   * `where region = 'EMEA'`, `where patient = 'A. Kowalski'` — chosen from sample
   * values or from what the user typed. Sending them under a schema-only badge
   * would make the badge a lie, so the history goes and the user is told it went.
   */
  const onStrictChange = useCallback((next: boolean) => {
    setStrict(next)
    if (next && history.current.length > 0) {
      history.current = []
      setStrictReset(true)
    } else {
      setStrictReset(false)
    }
  }, [])

  const onOverride = useCallback(async (column: string, type: string) => {
    setLoading(true)
    setLoadingNote('Re-reading that column…')
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
  }, [])

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '' || busy || exhausted) return

      setAsking(true)
      setFailure(null)
      setStrictReset(false)
      try {
        const answer = await ask(trimmed, TABLE, strict, { history: history.current })
        history.current = [...history.current, { question: trimmed, sql: answer.sql }]
        setTurns((previous) => [...previous, { question: trimmed, answer }])
        setQuestion('')
      } catch (error) {
        const quota = error instanceof PlanQuotaError
        setFailure({
          question: trimmed,
          headline: quota
            ? 'That used the last of today’s questions.'
            : describeQueryFailure(error),
          detail: error instanceof Error ? error.message : String(error),
          attempts: error instanceof AskFailedError ? error.attempts : [],
          quota,
        })
      } finally {
        setAsking(false)
        // A repair round-trip spends a second plan, so the count can move by two.
        // Reading it back beats guessing.
        void refreshQuota().catch(() => undefined)
      }
    },
    [busy, exhausted, refreshQuota, strict],
  )

  const starters = useMemo(
    () => sampleQuestions ?? (columns ? starterQuestions(columns) : []),
    [sampleQuestions, columns],
  )

  const upgrade = session?.isAnonymous ? (
    <p>
      You are anonymous, which is the lowest limit.{' '}
      <button type="button" className="link" onClick={() => void linkGitHub()}>
        Link GitHub
      </button>{' '}
      or{' '}
      <button type="button" className="link" onClick={() => void linkGoogle()}>
        Google
      </button>{' '}
      to raise it. Your sheet is not involved either way — it never left this tab.
    </p>
  ) : null

  return (
    <div className="shell">
      <header className="masthead">
        <h1>AskSheet</h1>
        <p className="tagline">Ask your spreadsheet questions. The answers come from your laptop.</p>
      </header>

      <PrivacyContract strict={strict} onStrictChange={onStrictChange} locked={asking} />

      {strictReset && (
        <div className="notice notice-warn" role="status">
          Strict mode cleared the conversation. Earlier queries can hold values from your sheet in
          their <code>WHERE</code> clauses, and strict mode means the server sees names and types
          only — so follow-ups start fresh.
        </div>
      )}

      {unsupported ? (
        <section className="panel" aria-labelledby="unsupported-heading">
          <h2 id="unsupported-heading">This browser cannot run AskSheet</h2>
          <p>{unsupported}</p>
          <p className="meta-line">
            There is no server-side fallback, and that is the point: the whole database runs in the
            page. Nothing about your data can be processed elsewhere because there is no elsewhere.
          </p>
        </section>
      ) : (
        <Dropzone onFile={(file) => void load(file, file.name)} onSample={onSample} busy={busy} />
      )}

      {loadError && (
        <div className="notice notice-error" role="alert">
          {loadError}
        </div>
      )}

      {loading && (
        <p className="meta-line" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> {loadingNote}
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
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || exhausted || question.trim() === ''}
              >
                {asking ? <span className="spinner" aria-hidden="true" /> : 'Ask'}
              </button>
            </form>

            {exhausted ? (
              <div className="notice notice-warn" role="status">
                <strong>No questions left today.</strong> The daily cap is on the planner, which is
                the only thing here that costs money. It resets at midnight UTC.
                {upgrade}
              </div>
            ) : (
              remaining && <p className="meta-line">{remaining}</p>
            )}

            {starters.length > 0 && (
              <div className="starters">
                {starters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    className="starter"
                    disabled={busy || exhausted}
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
            <span className="spinner" aria-hidden="true" /> Planning the query — schema only, and
            the one request that leaves this tab.
          </p>
        )}

        {failure && (
          <div className="notice notice-error" role="alert">
            <strong>Could not answer “{failure.question}”.</strong>
            <p>{failure.headline}</p>
            {failure.quota && upgrade}
            {failure.detail !== failure.headline && <pre>{failure.detail}</pre>}
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
