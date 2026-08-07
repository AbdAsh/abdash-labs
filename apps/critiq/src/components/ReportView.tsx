import { type ReactNode, useMemo, useState } from 'react'
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
import { CopyButton } from './CopyButton'
import { FindingCard } from './FindingCard'
import { GradeBadge } from './GradeBadge'
import { Measurements } from './Measurements'
import { PassedChecks } from './PassedChecks'
import { SeverityFilter } from './SeverityFilter'
import type { StoredReport } from '../lib/types'

/**
 * A report, rendered.
 *
 * Extracted from the report route so that the saved examples go through
 * exactly this code and not a simplified retelling of it. That is the whole
 * value of the example path: a reviewer who reads the example has seen the real
 * product — the same grades, the same severity filter, the same evidence
 * rendering, the same copyable fixes, the same passed-check list — rather than
 * a screenshot-grade approximation that would quietly differ from what they get
 * when they run one themselves.
 *
 * Everything that legitimately differs between a live report and a saved one is
 * a prop: where "Copy link" points, whether there is a delete button, and the
 * banner. Nothing below the banner knows which it is.
 */
export function ReportView({
  report,
  copyLink,
  banner,
  markdownNote,
  onDelete,
}: {
  report: StoredReport
  /** Absolute URL the "Copy link" button yields. */
  copyLink: string
  /** Provenance, pinned above the grade. Used to stamp a saved example. */
  banner?: ReactNode
  /** Carried into the markdown export, so a copied report keeps its label. */
  markdownNote?: string
  /** Supplied only when the caller owns a stored report. */
  onDelete?: () => void
}) {
  const [filter, setFilter] = useState<FindingFilter>(NO_FILTER)

  const findings = useMemo(() => report.findings ?? [], [report])
  const severityCounts = useMemo(() => countBySeverity(findings), [findings])
  const dimensionCounts = useMemo(() => countByDimension(findings), [findings])
  const visible = useMemo(() => filterFindings(findings, filter), [findings, filter])
  const groups = useMemo(() => groupByDimension(visible), [visible])
  const passed = useMemo(() => readPassed(report.digest), [report])
  const split = useMemo(() => sourceSplit(findings), [findings])

  const toggleDimension = (dimension: FindingFilter['dimension']) =>
    setFilter((current) => ({
      ...current,
      dimension: current.dimension === dimension ? 'all' : dimension,
    }))

  const judgeError = (report.digest as { judgeError?: string | null } | null)?.judgeError
  const truncated = (report.digest as { truncated?: boolean } | null)?.truncated === true

  return (
    <>
      <section className="panel report__head">
        {banner}

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
            <CopyButton text={copyLink} label="Copy link" copiedLabel="Link copied" />
            <CopyButton
              text={storedReportToMarkdown(report, formatDate(report.created_at), markdownNote)}
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
              {onDelete && (
                <button type="button" className="button button--danger" onClick={onDelete}>
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
            {onDelete && (
              <button type="button" className="button button--danger" onClick={onDelete}>
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
    </>
  )
}
