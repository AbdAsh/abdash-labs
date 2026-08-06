/**
 * Findings as markdown, so a fix can leave the report and land in a ticket.
 *
 * The report is where someone reads the problem; it is almost never where they
 * fix it. A "Copy" that yields the finding — severity, evidence, the fix, and
 * the markup — is the difference between a page you read and a page you can
 * act on without retyping anything.
 */
import { DIMENSION_LABELS, SOURCE_LABELS } from './format'
import { passedChecks } from './checks'
import type { Finding, Grades, StoredReport } from './types'

/** One finding, ready to paste into an issue. */
export function findingToMarkdown(finding: Finding): string {
  const out = [
    `### ${finding.title}`,
    '',
    `- **Severity:** ${finding.severity}`,
    `- **Dimension:** ${DIMENSION_LABELS[finding.dimension] ?? finding.dimension}`,
    `- **Source:** ${SOURCE_LABELS[finding.source] ?? finding.source} (\`${finding.id}\`)`,
  ]

  if (finding.evidence.trim() !== '') {
    out.push('', '**Evidence**', '', fence(finding.evidence))
  }
  if (finding.fix.trim() !== '') {
    out.push('', '**Fix**', '', finding.fix.trim())
  }
  if (finding.code && finding.code.trim() !== '') {
    out.push('', '**Suggested markup**', '', fence(finding.code, 'html'))
  }

  return out.join('\n')
}

export interface ReportMarkdownInput {
  url: string
  grades: Grades | null | undefined
  findings: Finding[]
  passed?: readonly string[]
  createdAt?: string
}

/** The whole report, in the order the page shows it. */
export function reportToMarkdown(report: ReportMarkdownInput): string {
  const findings = report.findings ?? []
  const overall = report.grades?.overall ?? '?'

  const out = [
    `# Critiq review — ${report.url}`,
    '',
    `**Overall grade: ${overall}** · ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
  ]

  if (report.createdAt) out.push('', `Reviewed ${report.createdAt}.`)

  const dimensionGrades = Object.entries(report.grades ?? {}).filter(([key]) => key !== 'overall')
  if (dimensionGrades.length > 0) {
    out.push('', '| Dimension | Grade |', '| --- | --- |')
    for (const [key, grade] of dimensionGrades) {
      out.push(`| ${DIMENSION_LABELS[key as keyof typeof DIMENSION_LABELS] ?? key} | ${grade} |`)
    }
  }

  if (findings.length === 0) {
    out.push('', 'No findings.')
  } else {
    out.push('', '## Findings')
    for (const finding of findings) out.push('', findingToMarkdown(finding))
  }

  const verified = passedChecks(report.passed)
  if (verified.length > 0) {
    out.push('', `## Verified (${verified.length})`, '')
    for (const check of verified) out.push(`- ${check.passed}`)
  }

  return `${out.join('\n')}\n`
}

/** Convenience for the report route, which holds a `StoredReport`. */
export function storedReportToMarkdown(report: StoredReport, createdAt?: string): string {
  return reportToMarkdown({
    url: report.url,
    grades: report.grades,
    findings: report.findings ?? [],
    passed: readPassed(report.digest),
    createdAt,
  })
}

/** The `passed` ids the function stored alongside the digest. */
export function readPassed(digest: Record<string, unknown> | null | undefined): string[] {
  const value = digest?.passed
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/**
 * Fences a block, widening the fence past any backtick run inside it. Evidence
 * is quoted from someone else's page, so it can contain anything — including
 * the three backticks that would end the block early and spill markup into the
 * surrounding text.
 */
function fence(body: string, lang = ''): string {
  const longest = [...body.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${lang}\n${body.trim()}\n${ticks}`
}
