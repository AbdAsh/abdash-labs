import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteReport, loadReport, ownsReport, ReviewError } from '../lib/api'
import {
  countByDimension,
  countBySeverity,
  DIMENSION_LABELS,
  DIMENSIONS,
  displayUrl,
  emptyFilterLabel,
  filterFindings,
  type FindingFilter,
  formatDate,
  groupByDimension,
  isFiltered,
  NO_FILTER,
  sourceSplit,
  summarise,
} from '../lib/format'
import { readPassed, storedReportToMarkdown } from '../lib/markdown'
import { FindingCard } from '../components/FindingCard'
import { GradeBadge } from '../components/GradeBadge'
import { SeverityFilter } from '../components/SeverityFilter'
import { PassedChecks } from '../components/PassedChecks'
import { Measurements } from '../components/Measurements'
import { ErrorPanel } from '../components/ErrorPanel'
import { CopyButton } from '../components/CopyButton'
import { reportPath, submitPath } from '../lib/router'
import type { StoredReport } from '../lib/types'

export function Report({ slug, navigate }: { slug: string; navigate: (path: string) => void }) {
  const [report, setReport] = useState<StoredReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ReviewError | null>(null)
  const [owned, setOwned] = useState(false)
  const [filter, setFilter] = useState<FindingFilter>(NO_FILTER)
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

  const findings = useMemo(() => report?.findings ?? [], [report])
  const severityCounts = useMemo(() => countBySeverity(findings), [findings])
  const dimensionCounts = useMemo(() => countByDimension(findings), [findings])
  const visible = useMemo(() => filterFindings(findings, filter), [findings, filter])
  const groups = useMemo(() => groupByDimension(visible), [visible])
  const passed = useMemo(() => readPassed(report?.digest), [report])
  const split = useMemo(() => sourceSplit(findings), [findings])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const toggleDimension = (dimension: FindingFilter['dimension']) =>
    setFilter((current) => ({
      ...current,
      dimension: current.dimension === dimension ? 'all' : dimension,
    }))

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

  const judgeError = (report.digest as { judgeError?: string | null } | null)?.judgeError
  const truncated = (report.digest as { truncated?: boolean } | null)?.truncated === true

  return (
    <div className="stack">
      <section className="panel report__head">
        <div className="report__summary">
          <GradeBadge grade={report.grades?.overall} large />
          <div className="report__identity">
            <h1 className="title">{displayUrl(report.url, 70)}</h1>
            <p className="report__headline">{summarise(findings)}</p>
            <p className="meta">
              <a href={report.url} rel="noopener nofollow noreferrer" target="_blank">
                Open the page
              </a>{' '}
              · reviewed {formatDate(report.created_at)}
              {findings.length > 0 && (
                <> · {split.measured} measured, {split.judged} judged</>
              )}
            </p>
          </div>
          <div className="report__actions">
            <CopyButton text={reportUrl(slug)} label="Copy link" copiedLabel="Link copied" />
            <CopyButton
              text={storedReportToMarkdown(report, formatDate(report.created_at))}
              label="Copy as markdown"
              copiedLabel="Report copied"
            />
          </div>
        </div>

        <div className="grades">
          {DIMENSIONS.map((dimension) => (
            <GradeBadge
              key={dimension}
              grade={report.grades?.[dimension]}
              label={DIMENSION_LABELS[dimension]}
              count={dimensionCounts[dimension]}
              active={filter.dimension === dimension}
              onClick={dimensionCounts[dimension] > 0 ? () => toggleDimension(dimension) : undefined}
            />
          ))}
        </div>

        {judgeError && (
          <p className="notice notice--warn">
            The judgment model failed on this run, so this report contains deterministic checks
            only. Nothing here is guesswork — there is simply less of it.
          </p>
        )}

        {truncated && (
          <p className="notice notice--warn">
            This page is larger than the 2 MB Critiq reads, so it was cut off. Everything measured
            from the body — word count, headings, images — is a floor rather than a total, and the
            content checks that depend on those totals were skipped rather than guessed.
          </p>
        )}
      </section>

      <section className="panel">
        {findings.length > 0 && (
          <div className="report__toolbar">
            <SeverityFilter
              counts={severityCounts}
              total={findings.length}
              value={filter.severity}
              onChange={(severity) => setFilter((current) => ({ ...current, severity }))}
            />
            <div className="report__toolbar-end">
              {isFiltered(filter) && (
                <button type="button" className="link" onClick={() => setFilter(NO_FILTER)}>
                  Clear filters
                </button>
              )}
              {owned && (
                <button type="button" className="button button--danger" onClick={() => void remove()}>
                  Delete report
                </button>
              )}
            </div>
          </div>
        )}

        {findings.length === 0 && (
          <div className="clean">
            <p className="lede">
              Nothing to report. Every mechanical check that applied to this page passed, and the
              model raised no judgment findings — which is a real result, not an empty one.
            </p>
            {owned && (
              <button type="button" className="button button--danger" onClick={() => void remove()}>
                Delete report
              </button>
            )}
          </div>
        )}

        {findings.length > 0 && visible.length === 0 && (
          <p className="lede">
            {emptyFilterLabel(filter)}{' '}
            <button type="button" className="link" onClick={() => setFilter(NO_FILTER)}>
              Show all {findings.length}
            </button>
          </p>
        )}

        {groups.map((group) => (
          <div key={group.dimension} className="group">
            <h2 className="subtitle">{DIMENSION_LABELS[group.dimension]}</h2>
            {group.findings.map((finding) => (
              <FindingCard key={`${finding.source}:${finding.id}`} finding={finding} />
            ))}
          </div>
        ))}

        <PassedChecks passed={passed} failedCount={findings.length} />
      </section>

      <Measurements digest={report.digest} />

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
