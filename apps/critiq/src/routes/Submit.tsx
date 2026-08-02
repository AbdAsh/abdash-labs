import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { linkGitHub, quotaFor, useSession, usedToday } from '@labs/platform'
import { listMyReports, requestReview } from '../lib/api'
import { displayUrl, formatDate, gradeTone, normaliseUrlInput, quotaLabel } from '../lib/format'
import { reportPath } from '../lib/router'
import type { ReportSummary } from '../lib/types'

/**
 * The stages a review actually goes through. It is one HTTP request, so these
 * are advertised as indicative rather than live — a fake progress bar that
 * claims to know where the server is would be the wrong kind of polish.
 */
const STAGES = [
  { at: 0, label: 'Fetching the page' },
  { at: 3500, label: 'Parsing and running checks' },
  { at: 7000, label: 'Asking the model for judgment' },
]

export function Submit({ navigate }: { navigate: (path: string) => void }) {
  const { session } = useSession()
  const [url, setUrl] = useState('')
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(0)
  const [used, setUsed] = useState(0)
  const [recent, setRecent] = useState<ReportSummary[]>([])

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

  useEffect(() => {
    if (!running) {
      setStage(0)
      return
    }
    const timers = STAGES.map((s, i) => setTimeout(() => setStage(i), s.at))
    return () => timers.forEach(clearTimeout)
  }, [running])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const target = normaliseUrlInput(url)
    if (target === '') {
      setError('Enter a URL to review.')
      return
    }

    setRunning(true)
    setError(null)
    try {
      const result = await requestReview(target)
      navigate(reportPath(result.slug))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      void refresh()
    } finally {
      setRunning(false)
    }
  }

  const exhausted = limit > 0 && used >= limit

  return (
    <div className="stack">
      <section className="panel">
        <h1 className="title">Critiq</h1>
        <p className="lede">
          Paste a URL and get the SEO review a senior practitioner would write — crawlability,
          metadata, content fit, semantics, structured data, and whether an AI answer engine can
          actually cite you.
        </p>

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
            <span className="spinner" aria-hidden="true" />
            <span>{STAGES[stage]?.label}…</span>
            <span className="progress__note">
              One request, one round trip — these stages are indicative timings, not live progress.
            </span>
          </div>
        )}

        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="panel panel--quiet">
        <h2 className="subtitle">What it checks</h2>
        <ul className="bullets">
          <li>
            <strong>Deterministic first.</strong> Twenty-two mechanical checks decide anything
            measurable — tag lengths, heading structure, robots rules, JSON-LD validity. Those are
            labelled <em>measured</em>.
          </li>
          <li>
            <strong>The model only judges.</strong> Is the title specific, does the body answer the
            intent, could an answer engine quote you. Labelled <em>judged</em>, and never allowed to
            restate a measurement.
          </li>
          <li>
            <strong>No JavaScript is executed.</strong> That is the point: a page with no content in
            its raw HTML has a real SEO problem, and Critiq reports it as a critical finding rather
            than hiding it behind a headless browser.
          </li>
        </ul>
      </section>

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
                  <span className={`dot dot--${gradeTone(report.grades?.overall)}`} aria-hidden="true" />
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
