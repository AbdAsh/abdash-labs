/**
 * Deterministic SEO checks over the digest.
 *
 * These are authoritative for mechanics. Anything measurable — a length, a
 * count, a header, a parse result — is decided here, and the merge step lets a
 * check beat an LLM finding on the same subject every time. The model is only
 * credited with judgment.
 *
 * Two rules the whole file obeys:
 *
 *  1. **Every finding carries real evidence** — the measured value or the
 *     offending markup, not a restatement of the rule — and a fix someone can
 *     act on without a second opinion.
 *  2. **Stronger findings suppress weaker ones on the same subject.** A page
 *     with no title does not also get "your title is the wrong length", and a
 *     page that is empty because it needs JavaScript is not also "thin".
 *     Duplicate scolding is what makes SEO tools unreadable.
 */
import type { Digest } from './digest.ts'

export type Dimension =
  | 'crawlability'
  | 'metadata'
  | 'content'
  | 'structure'
  | 'links'
  | 'structured-data'
  | 'answer-engine'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface Finding {
  id: string
  source: 'check' | 'llm'
  dimension: Dimension
  severity: Severity
  title: string
  evidence: string
  fix: string
  code?: string
}

export const DIMENSIONS: Dimension[] = [
  'crawlability',
  'metadata',
  'content',
  'structure',
  'links',
  'structured-data',
  'answer-engine',
]

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

/**
 * Every deterministic check, with the sentence to show when it *passes*.
 *
 * This list is the single source of truth for three things that were previously
 * three separate copies of the same knowledge:
 *
 *  - the "what we verified" list a clean report shows, which is the only way a
 *    reader can tell an empty report from a broken tool;
 *  - the id set `mergeFindings` uses to refuse an LLM finding that claims a
 *    mechanical result the check engine already measured and cleared;
 *  - the coverage assertion in the test suite.
 */
export const CHECK_CATALOGUE: readonly { id: string; dimension: Dimension; passed: string }[] = [
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

/** Every id `runChecks` can emit. Nothing else is a mechanical result. */
export const CHECK_IDS: ReadonlySet<string> = new Set(CHECK_CATALOGUE.map((c) => c.id))

/** The outcome of a deterministic pass: what failed, and what was cleared. */
export interface CheckResult {
  findings: Finding[]
  /**
   * Ids that were applicable to this page and did not fire. Deliberately not
   * "every id minus the failures": claiming `canonical-mismatch` passed on a
   * page with no canonical would be a report of a check that never ran.
   */
  passed: string[]
}

// Thresholds, gathered so they can be argued with in one place.
const TITLE_MIN = 25
const TITLE_MAX = 65
const DESCRIPTION_MIN = 70
const DESCRIPTION_MAX = 160
const THIN_WORDS = 300
const VERY_THIN_WORDS = 150
const JS_ONLY_WORDS = 100
const JS_ONLY_RATIO = 0.05
const ANSWERABLE_MIN_WORDS = 300
const GENERIC_ANCHOR_MIN = 3

const GENERIC_ANCHORS = new Set([
  'click here',
  'here',
  'read more',
  'learn more',
  'more',
  'more info',
  'more information',
  'this',
  'this page',
  'link',
  'this link',
  'continue',
  'continue reading',
  'details',
  'see more',
  'see details',
  'find out more',
  'go',
  'view',
  'download',
])

/** The findings only. See `review` when you also need what was cleared. */
export function runChecks(
  digest: Digest,
  robots: string | null,
  sitemap: string | null,
): Finding[] {
  return review(digest, robots, sitemap).findings
}

export function review(
  digest: Digest,
  robots: string | null,
  sitemap: string | null,
): CheckResult {
  // Callers hand us partial digests in tests, and a real page can be missing
  // almost anything. A check that throws produces no report at all, which is
  // worse than any finding it could have made.
  const d = normalise(digest)
  const out: Finding[] = []

  // A check is "evaluated" when this page gave it something to decide about.
  // `title-length` on a page with no title was never run, and reporting it as
  // passed would be the report lying about its own coverage.
  const evaluated = new Set<string>()
  const ran = (...ids: string[]) => {
    for (const id of ids) evaluated.add(id)
  }
  const add = (f: Omit<Finding, 'source'>) => {
    evaluated.add(f.id)
    out.push({ ...f, source: 'check' })
  }

  // ---- crawlability --------------------------------------------------------

  // A 4xx or 5xx body is not the page; everything below it is measuring an
  // error document. Reviewing one silently is the worst thing this tool could
  // do, because the report looks ordinary and is entirely about the wrong page.
  if (d.status > 0) {
    ran('http-status-error')
    if (d.status >= 400) {
      add({
        id: 'http-status-error',
        dimension: 'crawlability',
        severity: 'critical',
        title: `The page returns HTTP ${d.status}`,
        evidence: `${d.finalUrl} responded ${d.status}${
          d.redirects.length > 0 ? ` after ${d.redirects.length} redirect(s)` : ''
        }`,
        fix: d.status >= 500
          ? 'Fix the server error. Nothing else in this report matters until the page returns 200 — ' +
            'and everything below was measured against an error page, not your content.'
          : 'Restore the page or redirect the URL to its replacement. Everything below was measured ' +
            'against an error page, not your content.',
      })
    }
  }

  const noindexSource = [
    d.robotsMeta && ['meta name="robots"', d.robotsMeta] as const,
    d.googlebotMeta && ['meta name="googlebot"', d.googlebotMeta] as const,
    d.xRobotsTag && ['X-Robots-Tag header', d.xRobotsTag] as const,
  ].find((pair) => pair && /\b(noindex|none)\b/i.test(pair[1]))

  ran('noindex-present')
  if (noindexSource) {
    add({
      id: 'noindex-present',
      dimension: 'crawlability',
      severity: 'critical',
      title: 'The page tells search engines not to index it',
      evidence: `${noindexSource[0]}: ${noindexSource[1]}`,
      fix:
        'Remove the noindex directive, or accept that this page will never appear in search results. ' +
        'If the intent was to stop link equity flowing, use nofollow on the individual links instead.',
      code: '<meta name="robots" content="index, follow">',
    })
  }

  // Only claimed as checked when robots.txt was actually read. A site that
  // serves an HTML error page at /robots.txt has not been cleared for crawling;
  // we simply do not know.
  if (robots) {
    ran('robots-blocked')
    const rule = matchedRobotsRule(robots, pathOf(d.finalUrl))
    if (rule && !rule.allow) {
      add({
        id: 'robots-blocked',
        dimension: 'crawlability',
        severity: 'critical',
        title: 'robots.txt blocks crawlers from this page',
        evidence: `robots.txt matched "Disallow: ${rule.path}" against ${pathOf(d.finalUrl)}`,
        fix:
          `Remove or narrow that Disallow rule, or add a more specific Allow above it. ` +
          `A blocked page cannot be crawled, so nothing else on this report can help it rank.`,
        code: `Allow: ${pathOf(d.finalUrl)}`,
      })
    }
  }

  ran('canonical-missing')
  if (d.canonical === null) {
    // A missing canonical only *costs* something when there is a duplicate to
    // consolidate. On a clean, parameter-free URL a search engine
    // self-canonicalises and nothing is lost, so flagging it at medium on every
    // ordinary page is how a checklist turns into noise.
    const duplicable = queryOf(d.finalUrl) !== '' || d.redirects.length > 0
    add({
      id: 'canonical-missing',
      dimension: 'crawlability',
      severity: duplicable ? 'medium' : 'low',
      title: 'No canonical URL is declared',
      evidence: duplicable
        ? `No <link rel="canonical"> in the head, and this URL has variants: ${
          queryOf(d.finalUrl) !== '' ? `it carries the query "${queryOf(d.finalUrl)}"` : ''
        }${
          queryOf(d.finalUrl) !== '' && d.redirects.length > 0 ? ' and ' : ''
        }${d.redirects.length > 0 ? `it was reached through ${d.redirects.length} redirect(s)` : ''}`
        : `No <link rel="canonical"> in the head of ${d.finalUrl}`,
      fix: duplicable
        ? 'Declare the canonical URL. This page is reachable by more than one address, so without ' +
          'one those variants compete with each other instead of consolidating.'
        : 'Declare the canonical URL. Nothing is currently splitting this page\'s signals, so this ' +
          'is insurance rather than a repair — worth doing before the first tracking parameter ' +
          'shows up in a campaign.',
      code: `<link rel="canonical" href="${d.finalUrl}">`,
    })
  } else {
    ran('canonical-mismatch')
    const declared = normaliseForCompare(d.canonical)
    const actual = normaliseForCompare(d.finalUrl)
    if (declared !== null && actual !== null && declared !== actual) {
      const crossOrigin = originOf(d.canonical) !== originOf(d.finalUrl)
      add({
        id: 'canonical-mismatch',
        dimension: 'crawlability',
        severity: crossOrigin ? 'high' : 'medium',
        title: crossOrigin
          ? 'The canonical URL points at a different site'
          : 'The canonical URL points at a different page',
        evidence: `Fetched ${d.finalUrl} but the page declares canonical ${d.canonical}`,
        fix: crossOrigin
          ? 'A cross-origin canonical hands indexing to the other site. Point it at this URL unless ' +
            'this page is genuinely a syndicated copy.'
          : 'Point the canonical at this URL, or confirm the target really is the preferred version — ' +
            'a wrong canonical removes this page from the index as surely as a noindex.',
        code: `<link rel="canonical" href="${d.finalUrl}">`,
      })
    }
  }

  const declaresSitemap = robots !== null && /^\s*sitemap\s*:/im.test(robots)
  ran('sitemap-missing')
  if (!hasContent(sitemap) && !declaresSitemap) {
    add({
      id: 'sitemap-missing',
      dimension: 'crawlability',
      // Soft on purpose. We probed the conventional locations and read
      // robots.txt; a sitemap published somewhere else and submitted directly
      // in Search Console is invisible to us and perfectly valid.
      severity: 'low',
      title: 'No sitemap was found',
      evidence: [
        `${originOf(d.finalUrl) ?? 'the origin'}/sitemap.xml and /sitemap_index.xml returned ` +
        `nothing that parses as a sitemap`,
        robots === null
          ? 'robots.txt could not be read, so any Sitemap: line it may declare is unknown'
          : 'robots.txt declares no Sitemap: line',
      ].join(', and '),
      fix:
        'Publish a sitemap.xml and reference it from robots.txt. It is the cheapest way to tell a ' +
        'crawler which URLs exist and when they last changed. If you already have one somewhere ' +
        'else, add the Sitemap: line so it is discoverable without Search Console.',
      code: `Sitemap: ${originOf(d.finalUrl) ?? 'https://example.com'}/sitemap.xml`,
    })
  }

  // A bare http→https upgrade is one hop nobody should be scolded for: it is
  // what a correctly configured site does when someone types the address.
  const chain = [d.url, ...d.redirects]
  const costly = d.redirects.filter((to, i) => !isSchemeUpgrade(chain[i] ?? '', to))
  ran('redirect-chain')
  if (costly.length >= 2) {
    add({
      id: 'redirect-chain',
      dimension: 'crawlability',
      severity: costly.length >= 3 ? 'high' : 'medium',
      title: `The URL redirects ${d.redirects.length} times before resolving`,
      evidence: chain.join('\n  → '),
      fix:
        'Collapse the chain to a single redirect. Each hop costs crawl budget and latency, and ' +
        'some crawlers stop following after a handful.',
    })
  }

  // ---- metadata ------------------------------------------------------------

  ran('title-missing')
  if (!hasContent(d.title)) {
    add({
      id: 'title-missing',
      dimension: 'metadata',
      severity: 'high',
      title: 'The page has no title',
      evidence: 'No <title> element, or it is empty',
      fix:
        'Write a title that names the specific thing this page is about. It is the single largest ' +
        'on-page ranking factor and the headline of every search result.',
      code: '<title>Specific, distinct page title</title>',
    })
  } else {
    ran('title-length')
    const length = (d.title as string).trim().length
    if (length < TITLE_MIN || length > TITLE_MAX) {
      add({
        id: 'title-length',
        dimension: 'metadata',
        severity: length > TITLE_MAX ? 'medium' : 'low',
        title: length > TITLE_MAX
          ? `The title is ${length} characters and will be truncated`
          : `The title is only ${length} characters`,
        evidence: `${length} characters (aim for ${TITLE_MIN}–${TITLE_MAX}): "${d.title}"`,
        fix: length > TITLE_MAX
          ? `Trim to about ${TITLE_MAX} characters, front-loading the words that matter — search ` +
            `results cut the rest off mid-phrase.`
          : `Expand towards ${TITLE_MIN}–${TITLE_MAX} characters. A short title wastes the most ` +
            `valuable text on the page.`,
      })
    }
  }

  ran('description-missing')
  if (!hasContent(d.description)) {
    add({
      id: 'description-missing',
      dimension: 'metadata',
      severity: 'medium',
      title: 'No meta description',
      evidence: 'No <meta name="description"> with content',
      fix:
        'Write a description that earns the click. Search engines will otherwise assemble one from ' +
        'whatever page text happens to match the query.',
      code: '<meta name="description" content="One or two sentences that make the case for this page.">',
    })
  } else {
    ran('description-length')
    const length = (d.description as string).trim().length
    if (length < DESCRIPTION_MIN || length > DESCRIPTION_MAX) {
      add({
        id: 'description-length',
        dimension: 'metadata',
        severity: 'low',
        title: length > DESCRIPTION_MAX
          ? `The meta description is ${length} characters and will be cut short`
          : `The meta description is only ${length} characters`,
        evidence: `${length} characters (aim for ${DESCRIPTION_MIN}–${DESCRIPTION_MAX})`,
        fix:
          `Rewrite to roughly ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters so the whole sentence ` +
          `survives into the search result.`,
      })
    }
  }

  // ---- content -------------------------------------------------------------

  const jsOnly = d.wordCount < JS_ONLY_WORDS &&
    d.textHtmlRatio < JS_ONLY_RATIO &&
    d.scriptCount >= 1

  ran('js-only-content')
  if (jsOnly) {
    add({
      id: 'js-only-content',
      dimension: 'content',
      severity: 'critical',
      title: 'The page has almost no content without JavaScript',
      // The three numbers together are the argument. Script count alone proves
      // nothing — every modern site loads scripts.
      evidence: `The raw HTML contains ${d.wordCount} words and ${d.scriptCount} scripts, with a ` +
        `text-to-HTML ratio of ${(d.textHtmlRatio * 100).toFixed(1)}%. The response is a shell ` +
        `that renders client-side.` +
        (d.truncated
          ? ` (The response exceeded the size cap and was read only as far as ${d.htmlLength} ` +
            `bytes — which is itself the finding: that much markup carrying that little text.)`
          : ''),
      fix:
        'Server-render or pre-render this page. Crawlers that do not execute JavaScript — and every ' +
        'AI answer engine that fetches raw HTML — see an empty document, so the page cannot rank or ' +
        'be cited on content it does not contain.',
    })
  } else if (!d.truncated) {
    // Skipped entirely when the body was cut off at the size cap: `wordCount`
    // is then a floor, not a measurement, so "only 240 words" would be a claim
    // about the part we read, published as a claim about the page. Not fired,
    // and not reported as cleared either.
    ran('thin-content')
    if (d.wordCount < THIN_WORDS) {
      add({
        id: 'thin-content',
        dimension: 'content',
        severity: d.wordCount < VERY_THIN_WORDS ? 'high' : 'medium',
        title: `Only ${d.wordCount} words of body text`,
        evidence: `${d.wordCount} words, text-to-HTML ratio ${(d.textHtmlRatio * 100).toFixed(1)}%`,
        fix:
          'Add substance that answers the question this page targets. Word count is not a ranking ' +
          'factor on its own, but a page this short rarely covers a topic better than the pages ' +
          'above it.',
      })
    }
  }

  // ---- structure -----------------------------------------------------------

  const h1s = d.headings.filter((h) => h.level === 1)
  ran('h1-missing')
  if (h1s.length === 0) {
    add({
      id: 'h1-missing',
      dimension: 'structure',
      severity: 'high',
      title: 'No H1 heading',
      evidence: d.headings.length === 0
        ? 'The page has no headings at all'
        : `Headings start at h${d.headings[0]?.level}: "${d.headings[0]?.text}"`,
      fix:
        'Add a single H1 stating what the page is about. It is the strongest in-page signal of topic ' +
        'and the anchor for the rest of the outline.',
      code: '<h1>What this page is about</h1>',
    })
  } else {
    ran('h1-multiple')
    if (h1s.length > 1) {
      add({
        id: 'h1-multiple',
        dimension: 'structure',
        severity: 'low',
        title: `The page has ${h1s.length} H1 headings`,
        evidence: h1s.map((h) => `<h1>${h.text}</h1>`).join('\n'),
        fix:
          'Keep one H1 and demote the rest to H2. Several competing top-level headings blur what ' +
          'the page is primarily about.',
      })
    }
  }

  // Needs at least two headings before there is an outline to have a gap in.
  if (d.headings.length >= 2) ran('heading-skip')
  const skip = firstHeadingSkip(d.headings)
  if (skip) {
    add({
      id: 'heading-skip',
      dimension: 'structure',
      severity: 'low',
      title: 'The heading outline skips a level',
      evidence: `h${skip.from.level} "${skip.from.text}" is followed directly by ` +
        `h${skip.to.level} "${skip.to.text}"`,
      fix:
        `Use h${skip.from.level + 1} instead of h${skip.to.level}, or add the intermediate heading. ` +
        `The outline is how a machine reconstructs the structure of your argument.`,
    })
  }

  ran('lang-missing')
  if (!hasContent(d.lang)) {
    add({
      id: 'lang-missing',
      dimension: 'structure',
      severity: 'medium',
      title: 'The <html> element declares no language',
      evidence: 'No lang attribute on <html>',
      fix: 'Declare the page language so search engines serve it to the right audience.',
      code: '<html lang="en">',
    })
  }

  ran('viewport-missing')
  if (!hasContent(d.viewport)) {
    add({
      id: 'viewport-missing',
      dimension: 'structure',
      severity: 'medium',
      title: 'No viewport meta tag',
      evidence: 'No <meta name="viewport"> in the head',
      fix:
        'Add a viewport tag. Without it mobile browsers render at desktop width, and mobile-first ' +
        'indexing is what actually gets crawled.',
      code: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    })
  }

  const missingAlt = d.images.filter((i) => i.alt === null)
  if (d.images.length > 0) ran('img-alt-missing')
  if (d.images.length > 0 && missingAlt.length > 0) {
    const share = missingAlt.length / d.images.length
    add({
      id: 'img-alt-missing',
      dimension: 'structure',
      // Banded by scale as well as share. One un-described tracking pixel among
      // thirty properly-labelled images is worth a line in the report, not the
      // same severity as a gallery with no alt text at all.
      severity: share > 0.5 ? 'high' : (share > 0.2 || missingAlt.length >= 5) ? 'medium' : 'low',
      title: `${missingAlt.length} of ${d.images.length} images have no alt attribute`,
      evidence: missingAlt.slice(0, 4).map((i) => `<img src="${i.src}">`).join('\n'),
      fix:
        'Describe what each image shows. Use alt="" only for images that carry no information — ' +
        'that is a deliberate signal, and it is not the same as leaving the attribute off.',
      code: '<img src="…" alt="A description of what the image shows">',
    })
  }

  // ---- structured data -----------------------------------------------------

  // Only meaningful when there is a block to parse.
  const invalid = d.jsonLd.filter((b) => !b.valid)
  if (d.jsonLd.length > 0) {
    ran('jsonld-invalid')
    if (invalid.length > 0) {
      add({
        id: 'jsonld-invalid',
        dimension: 'structured-data',
        severity: 'high',
        title: invalid.length === 1
          ? 'A JSON-LD block does not parse'
          : `${invalid.length} JSON-LD blocks do not parse`,
        evidence: (invalid[0]?.raw ?? '').slice(0, 400),
        fix:
          'Fix the JSON syntax. A block that does not parse is ignored entirely, so the page gets ' +
          'no credit for structured data it believes it has.',
      })
    }
  }

  // Skipped on a shell page: it has no content to describe yet, and
  // `js-only-content` already said the only thing worth saying. Everywhere else
  // it is real but soft — structured data buys rich-result eligibility, not
  // rankings, and a great many well-built pages ship without it.
  if (!jsOnly) {
    ran('jsonld-missing')
    if (d.jsonLd.length === 0) {
      add({
        id: 'jsonld-missing',
        dimension: 'structured-data',
        severity: 'low',
        title: 'No JSON-LD structured data',
        evidence: 'No <script type="application/ld+json"> on the page',
        fix:
          'Add schema.org markup describing what this page is — Article, Product, FAQPage, Recipe. ' +
          'It is the most direct way to tell both search engines and answer engines what your ' +
          'entities are and how they relate.',
        code:
          '<script type="application/ld+json">\n{"@context":"https://schema.org","@type":"Article",' +
          '"headline":"…","author":{"@type":"Person","name":"…"},"datePublished":"…"}\n</script>',
      })
    }
  }

  // ---- links ---------------------------------------------------------------

  const generic = d.links.filter((l) => GENERIC_ANCHORS.has(l.text.trim().toLowerCase()))
  if (d.links.length > 0) ran('generic-anchor-text')
  if (generic.length >= GENERIC_ANCHOR_MIN) {
    add({
      id: 'generic-anchor-text',
      dimension: 'links',
      severity: 'low',
      title: `${generic.length} links use generic anchor text`,
      evidence: generic.slice(0, 5).map((l) => `"${l.text}" → ${l.href}`).join('\n'),
      fix:
        'Replace with text that describes the destination. Anchor text is one of the few signals you ' +
        'control about a page you are linking to, and "click here" spends it on nothing.',
    })
  }

  // ---- answer-engine readiness --------------------------------------------

  // Content-scoped counts, never the document-wide ones. Every site has a nav
  // built out of `<li>`, so `d.listItems` is dominated by the menu: keyed on it,
  // this check could not fire on any page with navigation, which is all of them.
  if (d.wordCount >= ANSWERABLE_MIN_WORDS) {
    ran('no-extractable-answers')
    if (d.mainListItems < 3 && d.mainTables === 0 && d.questionHeadings === 0) {
      add({
        id: 'no-extractable-answers',
        dimension: 'answer-engine',
        severity: 'medium',
        title: 'Nothing on this page is shaped like an extractable answer',
        evidence: `${d.wordCount} words across ${d.mainParagraphs} paragraphs of content, with ` +
          `${d.mainListItems} list items and ${d.mainTables} tables outside the navigation, and ` +
          `no question-form headings`,
        fix:
          'Add headings phrased as the questions readers actually ask, and answer each one ' +
          'immediately below in a self-contained sentence or two. An answer engine quotes passages ' +
          'it can lift without surrounding context; prose that only makes sense in sequence gives ' +
          'it nothing to cite.',
      })
    }
  }

  return { findings: out, passed: [...evaluated].filter((id) => !out.some((f) => f.id === id)) }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean
  path: string
}

/** True if `path` is disallowed for `agent` by this robots.txt. */
export function isBlockedByRobots(robots: string, path: string, agent = '*'): boolean {
  const rule = matchedRobotsRule(robots, path, agent)
  return rule !== null && !rule.allow
}

/**
 * Returns the rule that governs `path`, applying the real precedence: the most
 * specific group for the agent wins, and within it the longest matching rule
 * wins, with Allow beating Disallow on a tie.
 */
export function matchedRobotsRule(
  robots: string,
  path: string,
  agent = '*',
): RobotsRule | null {
  const groups = parseRobots(robots)
  const rules = groups.get(agent.toLowerCase()) ?? (agent === '*' ? undefined : groups.get('*'))
  if (!rules || rules.length === 0) return null

  let best: RobotsRule | null = null
  for (const rule of rules) {
    if (!robotsPathMatches(rule.path, path)) continue
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule
    }
  }
  return best
}

function parseRobots(text: string): Map<string, RobotsRule[]> {
  const groups = new Map<string, RobotsRule[]>()
  let pending: string[] = []
  let collecting = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (line === '') continue

    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    if (field === 'user-agent') {
      // A user-agent line after rules starts a new group; consecutive
      // user-agent lines share one.
      if (collecting) {
        pending = []
        collecting = false
      }
      pending.push(value.toLowerCase())
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), [])
      continue
    }

    if (field !== 'allow' && field !== 'disallow') continue
    if (pending.length === 0) continue
    collecting = true
    // `Disallow:` with no value means "nothing is disallowed" — not "block all".
    if (value === '') continue

    for (const ua of pending) {
      groups.get(ua)?.push({ allow: field === 'allow', path: value })
    }
  }

  return groups
}

function robotsPathMatches(rulePath: string, target: string): boolean {
  const anchored = rulePath.endsWith('$')
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  try {
    return new RegExp(`^${source}${anchored ? '$' : ''}`).test(target)
  } catch {
    return target.startsWith(pattern)
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hasContent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function firstHeadingSkip(
  headings: Digest['headings'],
): { from: { level: number; text: string }; to: { level: number; text: string } } | null {
  for (let i = 1; i < headings.length; i++) {
    const from = headings[i - 1]
    const to = headings[i]
    if (!from || !to) continue
    if (to.level - from.level > 1) return { from, to }
  }
  return null
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url.startsWith('/') ? url : '/'
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function queryOf(url: string): string {
  try {
    return new URL(url).search
  } catch {
    return ''
  }
}

/** True when the only thing the redirect changed was http → https. */
function isSchemeUpgrade(from: string, to: string): boolean {
  try {
    const a = new URL(from)
    const b = new URL(to)
    if (a.protocol !== 'http:' || b.protocol !== 'https:') return false
    return a.host === b.host && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

/**
 * Canonical comparison form: origin plus path plus query, with the fragment and
 * a trailing slash dropped. A trailing slash or a `#section` is not a canonical
 * mismatch, and reporting it as one trains people to ignore the finding.
 */
function normaliseForCompare(url: string): string | null {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`
  } catch {
    return null
  }
}

function normalise(d: Digest | null | undefined): Digest {
  const source = (d ?? {}) as Partial<Digest>
  const finalUrl = source.finalUrl ?? source.url ?? ''
  return {
    url: source.url ?? finalUrl,
    finalUrl,
    status: source.status ?? 0,
    redirects: source.redirects ?? [],
    elapsedMs: source.elapsedMs ?? 0,
    title: source.title ?? null,
    description: source.description ?? null,
    canonical: source.canonical ?? null,
    robotsMeta: source.robotsMeta ?? null,
    googlebotMeta: source.googlebotMeta ?? null,
    xRobotsTag: source.xRobotsTag ?? null,
    lang: source.lang ?? null,
    viewport: source.viewport ?? null,
    hreflang: source.hreflang ?? [],
    og: source.og ?? {},
    twitter: source.twitter ?? {},
    headings: source.headings ?? [],
    images: source.images ?? [],
    links: source.links ?? [],
    jsonLd: source.jsonLd ?? [],
    wordCount: source.wordCount ?? 0,
    textHtmlRatio: source.textHtmlRatio ?? 0,
    scriptCount: source.scriptCount ?? 0,
    htmlLength: source.htmlLength ?? 0,
    textLength: source.textLength ?? 0,
    lists: source.lists ?? 0,
    listItems: source.listItems ?? 0,
    tables: source.tables ?? 0,
    paragraphs: source.paragraphs ?? 0,
    // Fall back to the document-wide counts when a caller (a test, or a report
    // stored before these fields existed) supplies only those.
    mainListItems: source.mainListItems ?? source.listItems ?? 0,
    mainTables: source.mainTables ?? source.tables ?? 0,
    mainParagraphs: source.mainParagraphs ?? source.paragraphs ?? 0,
    questionHeadings: source.questionHeadings ?? 0,
    noscriptTextLength: source.noscriptTextLength ?? 0,
    internalLinks: source.internalLinks ?? 0,
    externalLinks: source.externalLinks ?? 0,
    truncated: source.truncated === true,
    mainText: source.mainText ?? '',
  }
}
