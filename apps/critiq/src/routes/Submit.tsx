import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { linkGitHub, quotaFor, useSession, usedToday } from '@labs/platform'
import { listMyReports, requestReview, ReviewError } from '../lib/api'
import {
  displayUrl,
  elapsedLabel,
  formatDate,
  gradeTone,
  normalizeUrlInput,
  quotaLabel,
  stageAt,
} from '../lib/format'
import { ErrorPanel } from '../components/ErrorPanel'
import { examplePath, reportPath } from '../lib/router'
import { EXAMPLES, exampleSummary } from '../example'
import type { ReportSummary } from '../lib/types'

/** Matches the Edge Function's own 15 s page budget, plus room for the model. */
const EXPECTED_MS = 25_000

export function Submit({ navigate }: { navigate: (path: string) => void }) {
  const { session } = useSession()
  const [url, setUrl] = useState('')
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<ReviewError | null>(null)
  const [limit, setLimit] = useState(0)
  const [used, setUsed] = useState(0)
  const [recent, setRecent] = useState<ReportSummary[]>([])
  const lastAttempt = useRef('')

  const refresh = useCallback(async () => {
    const [nextLimit, nextUsed, reports] = await Promise.all([
      quotaFor('critiq', 'reviews'),
      usedToday('critiq', 'reviews'),
      listMyReports(8).catch(() => [] as ReportSummary[]),
    ])
    setLimit(nextLimit)
    setUsed(nextUsed)
    setRecent(reports)
  }, [])

  useEffect(() => {
    if (session) void refresh()
  }, [session, refresh])

  // A real clock rather than a chain of timeouts. The stage labels are derived
  // from it, so what the page claims and what it has actually waited can never
  // drift apart.
  useEffect(() => {
    if (!running) {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const tick = setInterval(() => setElapsed(Date.now() - started), 250)
    return () => clearInterval(tick)
  }, [running])

  const run = useCallback(async (target: string) => {
    lastAttempt.current = target
    setRunning(true)
    setError(null)
    try {
      const result = await requestReview(target)
      navigate(reportPath(result.slug))
    } catch (e) {
      setError(e instanceof ReviewError ? e : new ReviewError(String(e)))
      void refresh()
    } finally {
      setRunning(false)
    }
  }, [navigate, refresh])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const target = normalizeUrlInput(url)
    if (target === '') {
      setError(new ReviewError('Enter a URL to review.', 400))
      return
    }
    void run(target)
  }

  const exhausted = limit > 0 && used >= limit
  const stage = stageAt(elapsed)
  const progress = Math.min(100, Math.round((elapsed / EXPECTED_MS) * 100))

  return (
    <div className="stack">
      <section className="panel">
        <h1 className="title">Critiq</h1>
        <p className="lede">
          Paste a URL and get the SEO review a senior practitioner would write — crawlability,
          metadata, content fit, semantics, structured data, and whether an AI answer engine can
          actually cite you.
        </p>

        {/* Before the form, deliberately. A run costs fifteen seconds and one of
            an anonymous visitor's one review for the day, which is far too much
            to charge someone for the question "what does this produce?" — so
            the finished answer is one free click, and it is offered first. */}
        <FirstLook navigate={navigate} />

        <form onSubmit={submit} className="form">
          <label className="visually-hidden" htmlFor="url">URL to review</label>
          <input
            id="url"
            className="input"
            type="text"
            inputMode="url"
            placeholder="abdash.net/blog/some-post"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={running}
            autoComplete="url"
          />
          <button type="submit" className="button" disabled={running || exhausted}>
            {running ? 'Reviewing…' : 'Review this page'}
          </button>
        </form>

        <p className="meta">{quotaLabel(used, limit)}</p>

        {/* Told before the run, not after. */}
        <p className="notice">
          Reports are <strong>public by default</strong>: anyone with the link can read one. They
          carry <code>noindex</code>, and you can delete yours at any time from its page.
        </p>

        {session?.isAnonymous && (
          <p className="notice notice--quiet">
            You are signed in anonymously with 1 review a day.{' '}
            <button type="button" className="link" onClick={() => void linkGitHub()}>
              Link a GitHub account
            </button>{' '}
            to raise that to 3 — your existing reports stay yours.
          </p>
        )}

        {running && (
          <div className="progress" aria-live="polite">
            <div className="progress__bar">
              <div className="progress__fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="progress__stage">
              <span className="spinner" aria-hidden="true" />
              <span>{stage.label}…</span>
              <span className="progress__clock">{elapsedLabel(elapsed)}</span>
            </p>
            <p className="progress__note">
              These are the real phases in the real order, but the timings are typical rather than
              live: a review is one request, so the page cannot see which phase the server is in.
              Most finish inside 20 seconds; the page fetch itself gives up at 15.
            </p>
          </div>
        )}

        {error && (
          <div className="panel-inset">
            <ErrorPanel
              error={{ status: error.status, message: error.message }}
              onRetry={lastAttempt.current ? () => void run(lastAttempt.current) : undefined}
            />
          </div>
        )}
      </section>

      <section className="panel panel--quiet">
        <h2 className="subtitle">What it checks</h2>
        <ul className="bullets">
          <li>
            <strong>Deterministic first.</strong> Twenty-three mechanical checks decide anything
            measurable — tag lengths, heading structure, robots rules, JSON-LD validity, HTTP
            status. Those are labelled <em>measured</em>, and the report lists the ones that
            passed as well as the ones that did not.
          </li>
          <li>
            <strong>The model only judges.</strong> Is the title specific, does the body answer the
            intent, could an answer engine quote you. Labelled <em>judged</em>, and never allowed to
            restate a measurement — including one the checks already took and cleared.
          </li>
          <li>
            <strong>No JavaScript is executed.</strong> That is the point: a page with no content in
            its raw HTML has a real SEO problem, and Critiq reports it as a critical finding rather
            than hiding it behind a headless browser.
          </li>
        </ul>
      </section>

      {EXAMPLES.length > 1 && (
        <section className="panel panel--quiet">
          <h2 className="subtitle">The saved examples</h2>
          <ul className="bullets">
            {EXAMPLES.map((example) => (
              <li key={example.id}>
                <a
                  href={examplePath(example.id)}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(examplePath(example.id))
                  }}
                >
                  <strong>{example.title}</strong>
                </a>{' '}
                — {displayUrl(example.url)}, {exampleSummary(example)}.
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="panel panel--quiet">
          <h2 className="subtitle">Your recent reviews</h2>
          <ul className="reports">
            {recent.map((report) => (
              <li key={report.slug}>
                <a
                  className="reports__link"
                  href={reportPath(report.slug)}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(reportPath(report.slug))
                  }}
                >
                  <span
                    className={`dot dot--${gradeTone(report.grades?.overall)}`}
                    aria-hidden="true"
                  />
                  <span className="reports__url">{displayUrl(report.url)}</span>
                  <span className="reports__grade">{report.grades?.overall ?? '—'}</span>
                  <span className="reports__date">{formatDate(report.created_at)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * The free path to a finished report.
 *
 * The numbers in the copy are read off the saved report rather than written
 * here, so regenerating an example can never leave the landing page advertising
 * a grade the example no longer has.
 */
function FirstLook({ navigate }: { navigate: (path: string) => void }) {
  const example = EXAMPLES[0]
  if (!example) return null

  return (
    <div className="firstlook">
      <div className="firstlook__body">
        <p className="firstlook__lead">See a finished report first</p>
        <p className="firstlook__note">
          A saved real review of {displayUrl(example.url)} — {exampleSummary(example)}. Instant,
          free, and it does not touch your daily quota.
        </p>
      </div>
      <a
        className="button firstlook__go"
        href={examplePath(example.id)}
        onClick={(e) => {
          e.preventDefault()
          navigate(examplePath(example.id))
        }}
      >
        See a finished example
      </a>
    </div>
  )
}
