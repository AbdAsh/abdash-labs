import { AuthGate, quotaFor, usedToday } from '@labs/platform'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnswerCard } from './components/Answer'
import { warmChartRenderer } from './components/Chart'
import { Dropzone } from './components/Dropzone'
import { ExamplePanel } from './components/ExamplePanel'
import { PrivacyContract } from './components/PrivacyContract'
import { SchemaChips } from './components/SchemaChips'
import { SqlDisclosure } from './components/SqlDisclosure'
import { UpgradePrompt } from './components/UpgradePrompt'
import {
  EXAMPLE,
  exampleSample,
  prerequisites,
  provenanceOf,
  type ReplayProvenance,
} from './example'
import { preflightCsv } from './lib/csv'
import { describeLoadFailure, describeQueryFailure } from './lib/csvErrors'
import { isEngineReady, overrideColumnType, registerCsv, runQuery, unsupportedReason } from './lib/duck'
import { ask, AskFailedError } from './lib/plan'
import { PlanQuotaError } from './lib/planClient'
import { starterQuestions } from './lib/starters'
import type { Answer, ColumnInfo, PlanHistoryItem } from './lib/types'
import { assertSingleSelect } from './lib/validate'
import type { Sample } from './samples'

const TABLE = 'data'

/**
 * Two paths, and the default is the cheap one.
 *
 * `example` replays SQL the planner wrote earlier against the bundled sample —
 * no round trip, no quota, and no network request of any kind. `live` is the
 * product: your sheet, your question, one call to plan it.
 */
type Mode = 'example' | 'live'

interface Turn {
  question: string
  answer: Answer
  /** Set when the turn replayed a saved plan instead of asking the planner. */
  replay?: ReplayProvenance
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

/**
 * Reads the daily allowance once, from inside the session gate.
 *
 * Not an effect in `App`, for two reasons. It would run on the example path,
 * where the promise is that nothing is requested at all — and it would run
 * before `AuthGate` had a session, which is two 401s in the console and a wrong
 * number on screen. Rendered as a child of the gate, neither can happen.
 */
function QuotaOnMount({ refresh }: { refresh: () => void }) {
  useEffect(() => {
    refresh()
  }, [refresh])
  return null
}

/** "17 of 20 questions left today", and the part people are surprised by. */
function plansLeft(used: number, limit: number | null): string | null {
  if (limit === null) return null
  if (limit <= 0) return 'Daily question limit unavailable.'
  const left = Math.max(0, limit - used)
  return `${left} of ${limit} question${limit === 1 ? '' : 's'} left today — a query that fails and has to be corrected costs two.`
}

export function App() {
  const [mode, setMode] = useState<Mode>('example')
  const [strict, setStrict] = useState(false)
  const [strictReset, setStrictReset] = useState(false)
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null)
  const [rowCount, setRowCount] = useState<number | null>(null)
  const [sourceName, setSourceName] = useState<string | null>(null)
  const [sampleQuestions, setSampleQuestions] = useState<string[] | null>(null)
  /** Which bundled sample is registered, or null for a file the visitor chose.
   *  Example mode needs the exact sample its plans were captured against. */
  const [loadedId, setLoadedId] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)
  const [loadingNote, setLoadingNote] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [failure, setFailure] = useState<AskFailure | null>(null)
  /** Example plans already in the transcript, so a follow-up does not replay its
   *  predecessor twice. */
  const [shown, setShown] = useState<number[]>([])

  const [limit, setLimit] = useState<number | null>(null)
  const [used, setUsed] = useState(0)

  const history = useRef<PlanHistoryItem[]>([])
  /** Kept apart from `asking` so the in-flight note does not claim a request is
   *  in the air when the whole point is that none is. */
  const [replaying, setReplaying] = useState(false)
  const busy = loading || asking || replaying

  const example = mode === 'example'
  /** The saved plans can only run once their own sample is registered. */
  const exampleReady = loadedId === EXAMPLE.sampleId && columns !== null

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

  const readQuota = useCallback(() => void refreshQuota().catch(() => undefined), [refreshQuota])

  const exhausted = limit !== null && limit > 0 && used >= limit
  const remaining = plansLeft(used, limit)

  const load = useCallback(async (input: File | string, name: string, sample?: Sample) => {
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
    setShown([])
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
        setLoadedId(null)
        return
      }

      const inferred = await registerCsv(input, TABLE)
      const counted = await runQuery(`select count(*) as n from "${TABLE}"`)
      setColumns(inferred)
      setRowCount(Number(counted.rows[0]?.[0] ?? 0))
      setSourceName(name)
      setSampleQuestions(sample?.questions ?? null)
      setLoadedId(sample?.id ?? null)
    } catch (error) {
      setColumns(null)
      setRowCount(null)
      setSourceName(null)
      setLoadedId(null)
      setLoadError(describeLoadFailure(error))
    } finally {
      setLoading(false)
    }
  }, [])

  const onSample = useCallback((sample: Sample) => void load(sample.csv, sample.name, sample), [load])

  const loadExample = useCallback(() => {
    const sample = exampleSample()
    void load(sample.csv, sample.name, sample)
  }, [load])

  // Example mode is the default, so the sample arrives without being asked for.
  // Driven imperatively from here and from `onModeChange` rather than from an
  // effect on `loadedId`: a failed load leaves `loadedId` null, and a reactive
  // version would then retry for ever against whatever is blocking it.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (mode === 'example' && !unsupported) loadExample()
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // See `warmChartRenderer`. One of the saved plans draws a chart, and the chart
  // library is code-split, so without this the click a visitor is watching in
  // DevTools would fetch a chunk. Deliberately after the sample is registered, so
  // it queues behind the engine download rather than competing with it.
  useEffect(() => {
    if (!example || !exampleReady) return
    if (!EXAMPLE.plans.some((plan) => plan.chart !== null)) return
    const timer = setTimeout(warmChartRenderer, 300)
    return () => clearTimeout(timer)
  }, [example, exampleReady])

  /**
   * Switching paths clears the transcript.
   *
   * The two kinds of answer carry different labels for good reason, and a mixed
   * list invites a reader to skim past the distinction. Reloading the sample when
   * returning to the example path matters more: the saved SQL names this CSV's
   * columns, so replaying it over a file the visitor loaded in live mode would
   * either error or, worse, quietly answer a different question.
   */
  const onModeChange = useCallback(
    (next: Mode) => {
      if (next === mode) return
      setMode(next)
      setTurns([])
      setShown([])
      setFailure(null)
      setStrictReset(false)
      history.current = []
      if (next === 'example' && !unsupported && loadedId !== EXAMPLE.sampleId) loadExample()
    },
    [mode, unsupported, loadedId, loadExample],
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

  /**
   * Replays a saved plan.
   *
   * Half of this is a recording and half of it is not, and the split is exact:
   * the SQL, the sentence and the chart spec come out of `fixture.json`; the rows
   * under them are produced right here by the same `runQuery` the live path uses,
   * against the same sample. No planner, no quota, no request.
   *
   * `assertSingleSelect` still runs. The fixture is model output that happens to
   * be older than this page load, and nothing about being saved makes it more
   * trustworthy than a plan that arrived a second ago.
   */
  const replay = useCallback(
    async (index: number) => {
      if (busy) return
      setReplaying(true)
      setFailure(null)

      // A follow-up shown alone is half a conversation, so its predecessors are
      // replayed first — unless they are already on screen.
      const queue = [...prerequisites(index).filter((earlier) => !shown.includes(earlier)), index]

      try {
        for (const position of queue) {
          const plan = EXAMPLE.plans[position]
          if (!plan) continue
          try {
            assertSingleSelect(plan.sql)
            const result = await runQuery(plan.sql)
            setTurns((previous) => [
              ...previous,
              {
                question: plan.question,
                answer: {
                  sql: plan.sql,
                  narration: plan.narration,
                  ...(plan.chart ? { chart: plan.chart } : {}),
                  result,
                  repaired: false,
                },
                replay: provenanceOf(plan),
              },
            ])
            setShown((previous) =>
              previous.includes(position) ? previous : [...previous, position],
            )
          } catch (error) {
            setFailure({
              question: plan.question,
              headline:
                'The saved plan would not run against the bundled sample. That is a fault in the ' +
                'recording rather than in the question — regenerate it with ' +
                'npm run capture:example -w apps/asksheet.',
              detail: error instanceof Error ? error.message : String(error),
              attempts: [plan.sql],
              quota: false,
            })
            break
          }
        }
      } finally {
        setReplaying(false)
      }
    },
    [busy, shown],
  )

  const starters = useMemo(
    () => sampleQuestions ?? (columns ? starterQuestions(columns) : []),
    [sampleQuestions, columns],
  )

  /** Load progress, load failure, and the schema of whatever is registered.
   *  Identical on both paths, but it sits inside the session gate on one of
   *  them and outside it on the other, so it is built once here. */
  const sheetStatus = (
    <>
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
        <SchemaChips
          columns={columns}
          rowCount={rowCount}
          onOverride={(column, type) => void onOverride(column, type)}
          busy={busy}
          readOnly={example}
        />
      )}
    </>
  )

  return (
    <div className="shell">
      <header className="masthead">
        <h1>AskSheet</h1>
        <p className="tagline">Ask your spreadsheet questions. The answers come from your laptop.</p>
      </header>

      {!unsupported && (
        <div className="mode-switch" role="group" aria-label="What to do here">
          <button
            type="button"
            className="mode"
            aria-pressed={example}
            disabled={busy}
            onClick={() => onModeChange('example')}
          >
            See a finished example
            <span>Three saved plans, run locally. No request, no allowance spent.</span>
          </button>
          <button
            type="button"
            className="mode"
            aria-pressed={!example}
            disabled={busy}
            onClick={() => onModeChange('live')}
          >
            Ask your own question
            <span>Your CSV or the samples, planned live. One request each.</span>
          </button>
        </div>
      )}

      <PrivacyContract
        strict={strict}
        onStrictChange={onStrictChange}
        locked={asking}
        live={!example}
      />

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
      ) : example ? (
        <>
          <ExamplePanel
            shown={shown}
            busy={busy}
            ready={exampleReady}
            onRun={(index) => void replay(index)}
            onAskYourOwn={() => onModeChange('live')}
          />
          {sheetStatus}
        </>
      ) : (
        /*
         * The session gate lives here, not around the whole app.
         *
         * `AuthGate` creates an anonymous account when none exists, which is a
         * request and a row on a server. The live path needs one — it is what the
         * planner authenticates and meters against — but the example path needs
         * nothing, and putting the gate at the root would have made a visitor who
         * only wanted to look at the demo sign up for it first. That would have
         * been the first thing DevTools showed a sceptic on a page whose whole
         * claim is about what it does not send.
         */
        <AuthGate>
          <QuotaOnMount refresh={readQuota} />

          <Dropzone onFile={(file) => void load(file, file.name)} onSample={onSample} busy={busy} />

          {sheetStatus}

          {columns && (
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
                  <strong>No questions left today.</strong> The daily cap is on the planner, which
                  is the only thing here that costs money. It resets at midnight UTC.
                  <UpgradePrompt />
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
          )}
        </AuthGate>
      )}

      <div aria-live="polite">
        {turns.map((turn, index) => (
          <AnswerCard
            key={`${index}-${turn.question}`}
            question={turn.question}
            answer={turn.answer}
            {...(turn.replay ? { replay: turn.replay } : {})}
          />
        ))}

        {asking && (
          <p className="meta-line">
            <span className="spinner" aria-hidden="true" /> Planning the query — schema only, and
            the one request that leaves this tab.
          </p>
        )}

        {replaying && (
          <p className="meta-line">
            <span className="spinner" aria-hidden="true" /> Running the saved SQL in this tab — no
            request, because the plan is already here.
          </p>
        )}

        {failure && (
          <div className="notice notice-error" role="alert">
            <strong>Could not answer “{failure.question}”.</strong>
            <p>{failure.headline}</p>
            {failure.quota && <UpgradePrompt />}
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
