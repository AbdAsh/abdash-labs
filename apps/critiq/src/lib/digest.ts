/**
 * The observed facts, read back out of the stored digest.
 *
 * A report that lists only what is *wrong* asks the reader to trust it. Showing
 * what was actually measured — the title we read, the word count, the status,
 * the schema types we found — lets them check the tool's homework, and it is
 * often the fastest way to spot that Critiq reviewed a redirect target, a
 * cookie wall or a 404 rather than the page they meant.
 *
 * Everything here reads a `jsonb` blob of unknown shape defensively: a report
 * stored by an older deploy is missing fields this build knows about, and a
 * missing field must render as absent rather than as `undefined`.
 */

export interface Measurement {
  label: string
  value: string
  /** Rendered in monospace — a URL, a status, a piece of markup. */
  mono?: boolean
}

export interface MeasurementGroup {
  title: string
  rows: Measurement[]
}

export function measurements(digest: Record<string, unknown> | null | undefined): MeasurementGroup[] {
  const d = digest ?? {}

  const groups: MeasurementGroup[] = [
    {
      title: 'Response',
      rows: compact([
        row('Status', num(d.status) === null ? null : String(num(d.status))),
        row('Content type', str(d.contentType), true),
        row('Fetched in', num(d.elapsedMs) === null ? null : `${num(d.elapsedMs)} ms`),
        row('Final URL', str(d.finalUrl), true),
        row('Redirects', list(d.redirects).length > 0 ? list(d.redirects).join(' → ') : null, true),
        row('Response size', num(d.htmlLength) === null ? null : bytes(num(d.htmlLength) as number)),
        d.truncated === true
          ? row('Read', 'Cut off at the size cap — counts below are a floor, not a total')
          : null,
      ]),
    },
    {
      title: 'Metadata',
      rows: compact([
        withLength('Title', str(d.title)),
        withLength('Description', str(d.description)),
        row('Canonical', str(d.canonical), true),
        row('Robots meta', str(d.robotsMeta), true),
        row('X-Robots-Tag', str(d.xRobotsTag), true),
        // "none" is a measurement and "we never looked" is not, so these only
        // appear when the digest actually carries the field. A report stored
        // before a field existed must not be made to assert its absence.
        present(d, 'og', () => row('Open Graph', keys(d.og).length > 0 ? keys(d.og).join(', ') : 'none')),
        present(
          d,
          'twitter',
          () => row('Twitter card', keys(d.twitter).length > 0 ? keys(d.twitter).join(', ') : 'none'),
        ),
      ]),
    },
    {
      title: 'Content',
      rows: compact([
        row('Words', num(d.wordCount) === null ? null : String(num(d.wordCount))),
        row(
          'Text-to-HTML',
          num(d.textHtmlRatio) === null ? null : `${((num(d.textHtmlRatio) as number) * 100).toFixed(1)}%`,
        ),
        row('Scripts', num(d.scriptCount) === null ? null : String(num(d.scriptCount))),
      ]),
    },
    {
      title: 'Structure',
      rows: compact([
        row('Language', str(d.lang), true),
        row('Viewport', str(d.viewport), true),
        row('Headings', headingSummary(d.headings)),
        row('Images', imageSummary(d.images)),
        row('Paragraphs', num(d.mainParagraphs) === null ? null : String(num(d.mainParagraphs))),
        row('List items in content', num(d.mainListItems) === null ? null : String(num(d.mainListItems))),
        row('Tables in content', num(d.mainTables) === null ? null : String(num(d.mainTables))),
        row(
          'Question-form headings',
          num(d.questionHeadings) === null ? null : String(num(d.questionHeadings)),
        ),
      ]),
    },
    {
      title: 'Links & structured data',
      rows: compact([
        row('Internal links', num(d.internalLinks) === null ? null : String(num(d.internalLinks))),
        row('External links', num(d.externalLinks) === null ? null : String(num(d.externalLinks))),
        present(d, 'jsonLd', () => row('JSON-LD types', jsonLdSummary(d.jsonLd))),
        row('robots.txt', d.robotsFound === undefined ? null : d.robotsFound ? 'read' : 'not readable'),
        row('Sitemap', d.sitemapFound === undefined ? null : d.sitemapFound ? 'found' : 'not found'),
      ]),
    },
  ]

  return groups.filter((group) => group.rows.length > 0)
}

/** The heading outline, for the structure panel. Capped: some pages have hundreds. */
export function headingOutline(
  digest: Record<string, unknown> | null | undefined,
  max = 40,
): { level: number; text: string }[] {
  const raw = list(digest?.headings)
  const out: { level: number; text: string }[] = []
  for (const item of raw.slice(0, max)) {
    if (item === null || typeof item !== 'object') continue
    const level = num((item as Record<string, unknown>).level)
    const text = str((item as Record<string, unknown>).text)
    if (level === null) continue
    out.push({ level, text: text ?? '(empty heading)' })
  }
  return out
}

// ---------------------------------------------------------------------------

/** Builds a row only when the digest carries the field at all. */
function present(
  d: Record<string, unknown>,
  key: string,
  build: () => Measurement | null,
): Measurement | null {
  return key in d ? build() : null
}

function row(label: string, value: string | null, mono = false): Measurement | null {
  if (value === null || value.trim() === '') return null
  return mono ? { label, value, mono } : { label, value }
}

function withLength(label: string, value: string | null): Measurement | null {
  if (value === null) return null
  return { label: `${label} (${value.length} chars)`, value }
}

function compact(rows: (Measurement | null)[]): Measurement[] {
  return rows.filter((r): r is Measurement => r !== null)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function keys(value: unknown): string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : []
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function headingSummary(value: unknown): string | null {
  const headings = list(value)
  if (headings.length === 0) return null
  const levels = new Map<number, number>()
  for (const h of headings) {
    const level = num((h as Record<string, unknown>)?.level)
    if (level !== null) levels.set(level, (levels.get(level) ?? 0) + 1)
  }
  const parts = [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, count]) => `${count}×h${level}`)
  return parts.length === 0 ? null : parts.join(', ')
}

function imageSummary(value: unknown): string | null {
  const images = list(value)
  if (images.length === 0) return null
  let missing = 0
  let decorative = 0
  for (const image of images) {
    const alt = (image as Record<string, unknown>)?.alt
    if (alt === null || alt === undefined) missing++
    else if (alt === '') decorative++
  }
  const described = images.length - missing - decorative
  return `${images.length} total — ${described} described, ${decorative} marked decorative, ` +
    `${missing} with no alt attribute`
}

function jsonLdSummary(value: unknown): string | null {
  const blocks = list(value)
  if (blocks.length === 0) return 'none'
  const types = new Set<string>()
  let invalid = 0
  for (const block of blocks) {
    const record = block as Record<string, unknown>
    if (record?.valid === false) invalid++
    for (const type of list(record?.types)) if (typeof type === 'string') types.add(type)
  }
  const named = types.size > 0 ? [...types].join(', ') : 'no @type found'
  return invalid > 0 ? `${named} (${invalid} block(s) do not parse)` : named
}
