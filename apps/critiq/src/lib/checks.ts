/**
 * What the deterministic engine verified.
 *
 * The Edge Function returns `passed` — the ids of the checks that were
 * applicable to this page and did not fire. Without a label per id the report
 * can only print slugs, so this is the client-side half of the catalogue in
 * `supabase/functions/critiq-review/checks.ts`.
 *
 * It is a mirror, not a copy of logic: the server decides what ran and what
 * passed, and this file only knows how to say it in English. An id that arrives
 * without an entry still renders, as itself, rather than vanishing — a report
 * that silently drops a verified check is worse than one showing a slug.
 */
import type { Dimension } from './types'

export interface CheckLabel {
  id: string
  dimension: Dimension
  /** The sentence to show when this check passed. */
  passed: string
}

export const CHECK_LABELS: readonly CheckLabel[] = [
  { id: 'http-status-error', dimension: 'crawlability', passed: 'The page returns a success status' },
  { id: 'noindex-present', dimension: 'crawlability', passed: 'Nothing tells search engines to skip this page' },
  { id: 'robots-blocked', dimension: 'crawlability', passed: 'robots.txt allows this page to be crawled' },
  { id: 'canonical-missing', dimension: 'crawlability', passed: 'A canonical URL is declared' },
  { id: 'canonical-mismatch', dimension: 'crawlability', passed: 'The canonical URL points at this page' },
  { id: 'sitemap-missing', dimension: 'crawlability', passed: 'A sitemap was found' },
  { id: 'redirect-chain', dimension: 'crawlability', passed: 'The URL resolves without a redirect chain' },
  { id: 'title-missing', dimension: 'metadata', passed: 'The page has a title' },
  { id: 'title-length', dimension: 'metadata', passed: 'The title fits a search result without truncation' },
  { id: 'description-missing', dimension: 'metadata', passed: 'The page has a meta description' },
  { id: 'description-length', dimension: 'metadata', passed: 'The meta description is a usable length' },
  { id: 'js-only-content', dimension: 'content', passed: 'The content is present without running JavaScript' },
  { id: 'thin-content', dimension: 'content', passed: 'The page carries enough body text to cover a topic' },
  { id: 'h1-missing', dimension: 'structure', passed: 'The page has an H1' },
  { id: 'h1-multiple', dimension: 'structure', passed: 'There is exactly one H1' },
  { id: 'heading-skip', dimension: 'structure', passed: 'The heading outline descends one level at a time' },
  { id: 'lang-missing', dimension: 'structure', passed: 'The page declares its language' },
  { id: 'viewport-missing', dimension: 'structure', passed: 'A viewport is declared for mobile rendering' },
  { id: 'img-alt-missing', dimension: 'structure', passed: 'Every image carries an alt attribute' },
  { id: 'jsonld-invalid', dimension: 'structured-data', passed: 'Every JSON-LD block parses' },
  { id: 'jsonld-missing', dimension: 'structured-data', passed: 'The page publishes JSON-LD structured data' },
  { id: 'generic-anchor-text', dimension: 'links', passed: 'Anchor text describes where links go' },
  { id: 'no-extractable-answers', dimension: 'answer-engine', passed: 'The content is shaped so a passage can be quoted' },
]

const BY_ID = new Map(CHECK_LABELS.map((c) => [c.id, c]))

/**
 * Resolves the ids the server reported as passed, in catalogue order.
 *
 * Unknown ids — a server ahead of this deploy — are kept at the end with the id
 * itself as the label, because dropping them would understate the coverage the
 * report actually has.
 */
export function passedChecks(ids: readonly string[] | null | undefined): CheckLabel[] {
  const wanted = new Set((ids ?? []).filter((id) => typeof id === 'string' && id.trim() !== ''))
  const known = CHECK_LABELS.filter((c) => wanted.has(c.id))
  const unknown = [...wanted]
    .filter((id) => !BY_ID.has(id))
    .sort()
    .map((id): CheckLabel => ({ id, dimension: 'crawlability', passed: id }))
  return [...known, ...unknown]
}

/**
 * "18 of 20 checks passed" — the sentence that makes an empty report legible.
 *
 * The denominator is what *ran*, never the size of the catalogue: a page with
 * no images never had its alt coverage checked, and counting that as a failure
 * to reach 100% would be the report marking itself down for work it correctly
 * did not do.
 */
export function coverageLabel(passedIds: readonly string[], failedCount: number): string {
  const passed = passedChecks(passedIds).length
  const total = passed + failedCount
  if (total === 0) return 'No mechanical checks applied to this page'
  return `${passed} of ${total} mechanical check${total === 1 ? '' : 's'} passed`
}
