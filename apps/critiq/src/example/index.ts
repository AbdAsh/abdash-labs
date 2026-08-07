/**
 * The saved examples, and everything the page says about them.
 *
 * A reviewer will not wait fifteen seconds and spend their one daily review to
 * find out what a report looks like, so there has to be a path that shows them
 * one instantly. The only honest version of that path is a real report, which
 * is why the two files next to this one are captured output from the deployed
 * function rather than a designer's mock — see `scripts/capture-example.mjs`.
 *
 * The division of labour here is deliberate. The `.json` files hold captured
 * facts and nothing else; this file holds the editorial copy about them. That
 * way there is nowhere in a fixture for a human to slip in a claim the function
 * never made, and nothing in here can change a grade or a finding.
 */
import type { Finding, Grades, StoredReport } from '../lib/types'

import selfAudit from './self-audit.json'
import jsOnly from './js-only.json'

export interface ExampleReport {
  id: string
  /** Tab label in the example switcher. */
  title: string
  /** Why this one is worth looking at, in one sentence. */
  blurb: string
  /** The URL that was reviewed, exactly as the report records it. */
  url: string
  /** When the review actually ran — not when the fixture file was written. */
  reviewedAt: string
  /** The slug the run produced, so the saved report can be traced to its row. */
  slug: string
  /** The stored row, in the shape the live report route receives. */
  report: StoredReport
}

/**
 * Ordered. The self-audit is first because it is the one that makes the case:
 * it is the author's own site, graded by the author's own tool, and the
 * findings are unflattering.
 */
export const EXAMPLES: readonly ExampleReport[] = [
  readCapture(selfAudit, {
    title: 'A self-audit',
    blurb:
      'Critiq reviewing the site of the person who wrote it. It comes back with a B and a ' +
      'high-severity finding about the page being hard for an answer engine to quote — which is ' +
      'the point: a tool whose author exempts himself from it is not worth running.',
  }),
  readCapture(jsOnly, {
    title: 'A JavaScript-only page',
    blurb:
      'A client-rendered app, fetched the way a crawler fetches it. Critiq executes no ' +
      'JavaScript, so it sees the empty shell that search engines and answer engines see — and ' +
      'reports it as critical rather than quietly papering over it with a headless browser.',
  }),
]

export const DEFAULT_EXAMPLE_ID = EXAMPLES[0]?.id ?? ''

/** The example for an id, or the default when the id is missing or unknown. */
export function findExample(id: string | null | undefined): ExampleReport | undefined {
  if (id === null || id === undefined || id === '') return EXAMPLES[0]
  return EXAMPLES.find((example) => example.id === id)
}

/**
 * The sentence that must never leave the page.
 *
 * A reader who cannot tell a saved report from one they just triggered has been
 * misled, and every other honesty property of this tool — measured versus
 * judged, passed checks listed, evidence quoted — is worth nothing if the
 * report itself is of unclear provenance. So the label names the URL and the
 * date, and says plainly that nobody ran this just now.
 */
export function exampleLabel(example: ExampleReport): string {
  return (
    `Saved example — a real Critiq review of ${example.url}, run on ` +
    `${exampleDate(example.reviewedAt)}. Nothing was fetched or graded when you opened this page.`
  )
}

/** The same sentence, for the markdown export — a copied report leaves the
 *  page, and the label has to travel with it. */
export function exampleMarkdownNote(example: ExampleReport): string {
  return (
    `Saved example: real captured output from a Critiq review of ${example.url} ` +
    `run on ${exampleDate(example.reviewedAt)}. Not a live review.`
  )
}

/**
 * "B overall · 4 findings · 23 checks passed" — the shape of the report,
 * counted from it.
 *
 * Used on the landing page to say what is behind the link. Every number is read
 * out of the captured report rather than typed into the copy, so the promise on
 * the button cannot drift away from the page it opens when an example is
 * regenerated and comes back with a different grade.
 */
export function exampleSummary(example: ExampleReport): string {
  const findings = example.report.findings?.length ?? 0
  const passed = readPassedCount(example.report.digest)
  const parts = [
    `${example.report.grades?.overall ?? '?'} overall`,
    `${findings} finding${findings === 1 ? '' : 's'}`,
  ]
  if (passed > 0) parts.push(`${passed} check${passed === 1 ? '' : 's'} passed`)
  return parts.join(' · ')
}

function readPassedCount(digest: Record<string, unknown> | null): number {
  const passed = digest?.passed
  return Array.isArray(passed) ? passed.length : 0
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * "7 August 2026", in UTC.
 *
 * Deliberately not `toLocaleDateString`: the label is a provenance claim, and a
 * provenance claim that shifts by a day depending on the reader's time zone —
 * or renders `8/7/2026` to a reader who reads that as 8 July — is a worse claim
 * than a slightly foreign-looking one. Spelling the month out settles it.
 */
export function exampleDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'an unrecorded date'
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/**
 * Turns a capture file into an example, refusing anything that is not one.
 *
 * Throws at import rather than degrading, because every failure mode here ends
 * with a page that claims to be a real report and is not: a fixture missing its
 * findings renders as a clean bill of health, and one missing its date renders
 * a label that cannot be checked. Neither is allowed to ship, and a build that
 * cannot import its own examples is the cheapest possible way to find out.
 */
export function readCapture(
  raw: unknown,
  editorial: { title: string; blurb: string },
): ExampleReport {
  const file = raw as {
    capture?: { id?: unknown; slug?: unknown; reviewedAt?: unknown }
    report?: Partial<StoredReport>
  }
  const capture = file?.capture ?? {}
  const report = file?.report

  const id = text(capture.id)
  const slug = text(capture.slug)
  const reviewedAt = text(capture.reviewedAt)

  if (id === '') throw new Error('Example capture has no id.')
  if (!report || typeof report !== 'object') throw new Error(`Example "${id}" has no report.`)
  if (slug === '') throw new Error(`Example "${id}" has no slug.`)
  if (reviewedAt === '' || Number.isNaN(new Date(reviewedAt).getTime())) {
    throw new Error(`Example "${id}" has no usable review date, so it cannot be labelled.`)
  }
  if (text(report.url) === '') throw new Error(`Example "${id}" has no reviewed URL.`)
  if (!Array.isArray(report.findings)) throw new Error(`Example "${id}" has no findings array.`)
  if (!report.grades?.overall) throw new Error(`Example "${id}" has no overall grade.`)

  return {
    id,
    title: editorial.title,
    blurb: editorial.blurb,
    url: report.url as string,
    reviewedAt,
    slug,
    report: {
      slug,
      url: report.url as string,
      status: text(report.status),
      grades: report.grades as Grades,
      findings: report.findings as Finding[],
      digest: (report.digest ?? null) as Record<string, unknown> | null,
      created_at: text(report.created_at) || reviewedAt,
    },
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
