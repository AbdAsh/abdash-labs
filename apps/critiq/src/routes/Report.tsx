import { useCallback, useEffect, useState } from 'react'
import { deleteReport, loadReport, ownsReport, ReviewError } from '../lib/api'
import { displayUrl } from '../lib/format'
import { ErrorPanel } from '../components/ErrorPanel'
import { ReportView } from '../components/ReportView'
import { reportPath, submitPath } from '../lib/router'
import type { StoredReport } from '../lib/types'

export function Report({ slug, navigate }: { slug: string; navigate: (path: string) => void }) {
  const [report, setReport] = useState<StoredReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ReviewError | null>(null)
  const [owned, setOwned] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    loadReport(slug)
      .then(async (found) => {
        if (cancelled) return
        setReport(found)
        if (found) setOwned(await ownsReport(slug).catch(() => false))
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ReviewError ? e : new ReviewError(String(e)))
      })
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [slug, attempt])

  // A report page must never be indexed — Critiq is not a name-and-shame
  // surface. Set on this route only, so the landing page stays indexable.
  useEffect(() => {
    const tag = document.createElement('meta')
    tag.name = 'robots'
    tag.content = 'noindex, nofollow'
    document.head.appendChild(tag)
    return () => tag.remove()
  }, [])

  // Real OG tags need prerendering, which a static SPA cannot do. Phase 2.
  // Until then, at least a shared link has an accurate title in the tab.
  useEffect(() => {
    if (!report) return
    const previous = document.title
    document.title = `Critiq — ${report.grades?.overall ?? '?'} — ${displayUrl(report.url, 40)}`
    return () => {
      document.title = previous
    }
  }, [report])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const remove = async () => {
    if (!window.confirm('Delete this report? The link will stop working.')) return
    try {
      await deleteReport(slug)
      navigate(submitPath())
    } catch (e) {
      setError(e instanceof ReviewError ? e : new ReviewError(String(e)))
    }
  }

  if (loading) {
    return (
      <div className="panel" aria-busy="true">
        <span className="spinner" aria-hidden="true" /> Loading report…
      </div>
    )
  }

  if (error) {
    return (
      <div className="panel">
        <ErrorPanel error={{ status: error.status, message: error.message }} onRetry={retry} />
        <BackLink navigate={navigate} />
      </div>
    )
  }

  if (!report) {
    return (
      <div className="panel">
        <h1 className="title">No such report</h1>
        <p className="lede">
          This link does not point at a report. Reports can be deleted by whoever ran them, so a
          link that worked yesterday may have been taken down — there is no history to recover it
          from, by design.
        </p>
        <BackLink navigate={navigate} />
      </div>
    )
  }

  return (
    <div className="stack">
      <ReportView
        report={report}
        copyLink={reportUrl(slug)}
        onDelete={owned ? () => void remove() : undefined}
      />
      <BackLink navigate={navigate} />
    </div>
  )
}

/** Through `reportPath`, so the shared link can never drift from the router. */
function reportUrl(slug: string): string {
  return `${window.location.origin}${reportPath(slug)}`
}

function BackLink({ navigate }: { navigate: (path: string) => void }) {
  return (
    <p className="meta">
      <a
        href={submitPath()}
        onClick={(e) => {
          e.preventDefault()
          navigate(submitPath())
        }}
      >
        Review another page
      </a>
    </p>
  )
}
