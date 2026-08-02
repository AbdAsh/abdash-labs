import { useEffect, useMemo, useState } from 'react'
import { deleteReport, loadReport, ownsReport } from '../lib/api'
import {
  countBySeverity,
  DIMENSION_LABELS,
  DIMENSIONS,
  displayUrl,
  filterBySeverity,
  formatDate,
  groupByDimension,
} from '../lib/format'
import { FindingCard } from '../components/FindingCard'
import { GradeBadge } from '../components/GradeBadge'
import { SeverityFilter } from '../components/SeverityFilter'
import { submitPath } from '../lib/router'
import type { Severity, StoredReport } from '../lib/types'

export function Report({ slug, navigate }: { slug: string; navigate: (path: string) => void }) {
  const [report, setReport] = useState<StoredReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [owned, setOwned] = useState(false)
  const [severity, setSeverity] = useState<Severity | 'all'>('all')

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
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [slug])

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

  const findings = useMemo(() => report?.findings ?? [], [report])
  const counts = useMemo(() => countBySeverity(findings), [findings])
  const visible = useMemo(() => filterBySeverity(findings, severity), [findings, severity])
  const groups = useMemo(() => groupByDimension(visible), [visible])

  const remove = async () => {
    if (!globalThis.confirm('Delete this report? The link will stop working.')) return
    try {
      await deleteReport(slug)
      navigate(submitPath())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) return <div className="panel" aria-busy="true">Loading report…</div>

  if (error) {
    return (
      <div className="panel">
        <h1 className="title">Could not open this report</h1>
        <p className="error" role="alert">{error}</p>
        <BackLink navigate={navigate} />
      </div>
    )
  }

  if (!report) {
    return (
      <div className="panel">
        <h1 className="title">No such report</h1>
        <p className="lede">
          This link does not point at a report. It may have been deleted by the person who ran it.
        </p>
        <BackLink navigate={navigate} />
      </div>
    )
  }

  const judgeError = (report.digest as { judgeError?: string | null } | null)?.judgeError

  return (
    <div className="stack">
      <section className="panel report__head">
        <div className="report__summary">
          <GradeBadge grade={report.grades?.overall} large />
          <div>
            <h1 className="title">{displayUrl(report.url, 70)}</h1>
            <p className="meta">
              <a href={report.url} rel="noopener nofollow noreferrer" target="_blank">
                Open the page
              </a>{' '}
              · reviewed {formatDate(report.created_at)} · {findings.length}{' '}
              finding{findings.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="grades">
          {DIMENSIONS.map((dimension) => (
            <GradeBadge
              key={dimension}
              grade={report.grades?.[dimension]}
              label={DIMENSION_LABELS[dimension]}
            />
          ))}
        </div>

        {judgeError && (
          <p className="notice notice--warn">
            The judgment model failed on this run, so this report contains deterministic checks
            only. Nothing here is guesswork — there is simply less of it.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="report__toolbar">
          <SeverityFilter
            counts={counts}
            total={findings.length}
            value={severity}
            onChange={setSeverity}
          />
          {owned && (
            <button type="button" className="button button--danger" onClick={() => void remove()}>
              Delete report
            </button>
          )}
        </div>

        {findings.length === 0 && (
          <p className="lede">
            Nothing to report. Every mechanical check passed and the model raised no judgment
            findings.
          </p>
        )}

        {findings.length > 0 && visible.length === 0 && (
          <p className="lede">No {severity} findings. Try another filter.</p>
        )}

        {groups.map((group) => (
          <div key={group.dimension} className="group">
            <h2 className="subtitle">{DIMENSION_LABELS[group.dimension]}</h2>
            {group.findings.map((finding) => (
              <FindingCard key={`${finding.source}:${finding.id}`} finding={finding} />
            ))}
          </div>
        ))}
      </section>

      <BackLink navigate={navigate} />
    </div>
  )
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
