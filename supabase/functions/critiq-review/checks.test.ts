import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import type { Digest } from './digest.ts'
import { CHECK_CATALOGUE, CHECK_IDS, isBlockedByRobots, review, runChecks } from './checks.ts'

/** A page with nothing wrong with it. Every test mutates one thing off this. */
function healthy(over: Partial<Digest> = {}): Digest {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    status: 200,
    redirects: [],
    elapsedMs: 210,
    title: 'How to bake sourdough bread at home',
    description:
      'A practical, tested guide to baking sourdough at home, covering starters, hydration, proofing times and oven setup.',
    canonical: 'https://example.com/page',
    robotsMeta: 'index, follow',
    googlebotMeta: null,
    xRobotsTag: null,
    lang: 'en',
    viewport: 'width=device-width, initial-scale=1',
    hreflang: [],
    og: { title: 'Sourdough' },
    twitter: { card: 'summary' },
    headings: [
      { level: 1, text: 'How to bake sourdough bread at home' },
      { level: 2, text: 'What is a starter?' },
      { level: 2, text: 'How long should dough proof?' },
      { level: 3, text: 'Warm kitchens' },
    ],
    images: [
      { src: 'https://example.com/a.png', alt: 'A finished loaf' },
      { src: 'https://example.com/b.png', alt: '' },
    ],
    links: [
      { href: 'https://example.com/starters', text: 'building a starter', rel: null, internal: true },
      { href: 'https://example.com/hydration', text: 'hydration ratios', rel: null, internal: true },
      { href: 'https://king.test/flour', text: 'flour protein content', rel: null, internal: false },
    ],
    jsonLd: [{ valid: true, types: ['Recipe'], raw: '{"@type":"Recipe"}' }],
    wordCount: 1400,
    textHtmlRatio: 0.28,
    scriptCount: 8,
    htmlLength: 50000,
    textLength: 14000,
    lists: 2,
    listItems: 7,
    tables: 1,
    paragraphs: 22,
    mainListItems: 7,
    mainTables: 1,
    mainParagraphs: 22,
    questionHeadings: 2,
    noscriptTextLength: 0,
    internalLinks: 2,
    externalLinks: 1,
    truncated: false,
    mainText: 'Sourdough needs time.',
    ...over,
  }
}

const SITEMAP = '<?xml version="1.0"?><urlset><url><loc>https://example.com/page</loc></url></urlset>'
const ROBOTS = 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n'

const run = (over: Partial<Digest> = {}, robots: string | null = ROBOTS, sitemap: string | null = SITEMAP) =>
  runChecks(healthy(over), robots, sitemap)

const ids = (over?: Partial<Digest>, robots?: string | null, sitemap?: string | null) =>
  run(over, robots, sitemap).map((f) => f.id)

const find = (over: Partial<Digest>, id: string, robots?: string | null, sitemap?: string | null) =>
  run(over, robots, sitemap).find((f) => f.id === id)

// ---------------------------------------------------------------------------
// The no-false-positive baseline
// ---------------------------------------------------------------------------

Deno.test('a healthy page produces no findings at all', () => {
  assertEquals(run(), [])
})

Deno.test('every finding carries a source, concrete evidence and an actionable fix', () => {
  const findings = runChecks(healthy({ title: null, canonical: null, jsonLd: [] }), null, null)
  assertEquals(findings.length > 0, true)
  for (const f of findings) {
    assertEquals(f.source, 'check', f.id)
    assertEquals(f.evidence.trim().length > 0, true, `${f.id} has no evidence`)
    assertEquals(f.fix.trim().length > 0, true, `${f.id} has no fix`)
    assertEquals(typeof f.title, 'string')
  }
})

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

Deno.test('title-missing', () => {
  assertEquals(find({ title: null }, 'title-missing')?.severity, 'high')
  assertEquals(find({ title: '   ' }, 'title-missing')?.severity, 'high')
  assertEquals(find({}, 'title-missing'), undefined)
})

Deno.test('title-length flags both extremes and reports the measured length', () => {
  const short = find({ title: 'Home' }, 'title-length')
  assertEquals(short?.severity, 'low')
  assertStringIncludes(short?.evidence ?? '', '4')

  const long = find({ title: 'A'.repeat(90) }, 'title-length')
  assertEquals(long?.severity, 'medium')
  assertStringIncludes(long?.evidence ?? '', '90')

  assertEquals(find({}, 'title-length'), undefined)
  // A missing title is one finding, not two.
  assertEquals(ids({ title: null }).includes('title-length'), false)
})

Deno.test('description-missing', () => {
  assertEquals(find({ description: null }, 'description-missing')?.severity, 'medium')
  assertEquals(find({}, 'description-missing'), undefined)
})

Deno.test('description-length', () => {
  assertEquals(find({ description: 'Too short.' }, 'description-length')?.severity, 'low')
  assertEquals(find({ description: 'x'.repeat(300) }, 'description-length')?.severity, 'low')
  assertEquals(find({}, 'description-length'), undefined)
  assertEquals(ids({ description: null }).includes('description-length'), false)
})

// ---------------------------------------------------------------------------
// Crawlability
// ---------------------------------------------------------------------------

Deno.test('canonical-missing', () => {
  // Severity is context-sensitive; see the noise-control block below.
  assertEquals(find({ canonical: null }, 'canonical-missing')?.severity, 'low')
  assertEquals(find({}, 'canonical-missing'), undefined)
})

Deno.test('canonical-mismatch ignores cosmetic differences but catches real ones', () => {
  // Trailing slash and fragment are not a mismatch.
  assertEquals(find({ canonical: 'https://example.com/page/' }, 'canonical-mismatch'), undefined)
  assertEquals(find({ canonical: 'https://example.com/page#top' }, 'canonical-mismatch'), undefined)

  const other = find({ canonical: 'https://example.com/different' }, 'canonical-mismatch')
  assertEquals(other?.severity, 'medium')

  // Pointing at another origin de-indexes this page in favour of someone else's.
  const cross = find({ canonical: 'https://cdn.other.test/page' }, 'canonical-mismatch')
  assertEquals(cross?.severity, 'high')
})

Deno.test('noindex-present fires from meta robots, googlebot and the header', () => {
  assertEquals(find({ robotsMeta: 'noindex, follow' }, 'noindex-present')?.severity, 'critical')
  assertEquals(find({ robotsMeta: 'NONE' }, 'noindex-present')?.severity, 'critical')
  assertEquals(find({ googlebotMeta: 'noindex' }, 'noindex-present')?.severity, 'critical')
  assertEquals(find({ xRobotsTag: 'noindex' }, 'noindex-present')?.severity, 'critical')
  assertEquals(find({}, 'noindex-present'), undefined)
  // "nofollow" alone is not "noindex".
  assertEquals(find({ robotsMeta: 'index, nofollow' }, 'noindex-present'), undefined)
})

Deno.test('robots-blocked', () => {
  const blocked = find({}, 'robots-blocked', 'User-agent: *\nDisallow: /page\n')
  assertEquals(blocked?.severity, 'critical')
  assertStringIncludes(blocked?.evidence ?? '', 'Disallow: /page')

  assertEquals(find({}, 'robots-blocked', 'User-agent: *\nDisallow: /admin\n'), undefined)
  assertEquals(find({}, 'robots-blocked', null), undefined)
})

Deno.test('isBlockedByRobots honours groups, wildcards, anchors and Allow precedence', () => {
  const txt = [
    'User-agent: badbot',
    'Disallow: /',
    '',
    'User-agent: *',
    'Disallow: /private/',
    'Disallow: /*.pdf$',
    'Disallow: /shop',
    'Allow: /shop/public',
  ].join('\n')

  assertEquals(isBlockedByRobots(txt, '/private/x'), true)
  assertEquals(isBlockedByRobots(txt, '/report.pdf'), true)
  assertEquals(isBlockedByRobots(txt, '/report.pdf?x=1'), false) // $ anchors the match
  assertEquals(isBlockedByRobots(txt, '/shop/items'), true)
  assertEquals(isBlockedByRobots(txt, '/shop/public/a'), false) // longer Allow wins
  assertEquals(isBlockedByRobots(txt, '/blog/post'), false)
  // A group for another agent must not leak into the wildcard group.
  assertEquals(isBlockedByRobots('User-agent: badbot\nDisallow: /\n', '/anything'), false)
  // An empty Disallow means "allow everything".
  assertEquals(isBlockedByRobots('User-agent: *\nDisallow:\n', '/anything'), false)
  // Comments and odd casing.
  assertEquals(isBlockedByRobots('# note\nUSER-AGENT: *\nDISALLOW: /x  # why\n', '/x'), true)
})

Deno.test('sitemap-missing', () => {
  assertEquals(find({}, 'sitemap-missing', 'User-agent: *\n', null)?.severity, 'low')
  // A Sitemap: directive in robots.txt counts, even when /sitemap.xml 404s.
  assertEquals(
    find({}, 'sitemap-missing', 'Sitemap: https://example.com/sm/index.xml\n', null),
    undefined,
  )
  assertEquals(find({}, 'sitemap-missing'), undefined)
})

Deno.test('redirect-chain fires on a chain, not on a single hop', () => {
  assertEquals(find({ redirects: ['https://example.com/page'] }, 'redirect-chain'), undefined)
  const two = find({ redirects: ['https://example.com/a', 'https://example.com/page'] }, 'redirect-chain')
  assertEquals(two?.severity, 'medium')
  const three = find({
    redirects: ['https://example.com/a', 'https://example.com/b', 'https://example.com/page'],
  }, 'redirect-chain')
  assertEquals(three?.severity, 'high')
})

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

Deno.test('h1-missing', () => {
  const f = find({ headings: [{ level: 2, text: 'Section' }] }, 'h1-missing')
  assertEquals(f?.severity, 'high')
  assertEquals(find({}, 'h1-missing'), undefined)
})

Deno.test('h1-multiple', () => {
  const f = find({
    headings: [{ level: 1, text: 'One' }, { level: 1, text: 'Two' }],
  }, 'h1-multiple')
  assertEquals(f?.severity, 'low')
  assertStringIncludes(f?.evidence ?? '', 'Two')
  assertEquals(find({}, 'h1-multiple'), undefined)
})

Deno.test('heading-skip', () => {
  const f = find({
    headings: [{ level: 1, text: 'Top' }, { level: 4, text: 'Deep' }],
  }, 'heading-skip')
  assertEquals(f?.severity, 'low')
  assertStringIncludes(f?.evidence ?? '', 'h1')
  assertStringIncludes(f?.evidence ?? '', 'h4')
  // Going back up any number of levels is normal.
  assertEquals(
    find({
      headings: [
        { level: 1, text: 'A' },
        { level: 2, text: 'B' },
        { level: 3, text: 'C' },
        { level: 2, text: 'D' },
      ],
    }, 'heading-skip'),
    undefined,
  )
})

Deno.test('lang-missing', () => {
  assertEquals(find({ lang: null }, 'lang-missing')?.severity, 'medium')
  assertEquals(find({}, 'lang-missing'), undefined)
})

Deno.test('viewport-missing', () => {
  assertEquals(find({ viewport: null }, 'viewport-missing')?.severity, 'medium')
  assertEquals(find({}, 'viewport-missing'), undefined)
})

Deno.test('img-alt-missing counts only absent alts, never empty ones', () => {
  const decorative = find({
    images: [
      { src: 'https://example.com/1.png', alt: '' },
      { src: 'https://example.com/2.png', alt: '' },
      { src: 'https://example.com/3.png', alt: '' },
    ],
  }, 'img-alt-missing')
  assertEquals(decorative, undefined)

  const f = find({
    images: [
      { src: 'https://example.com/1.png', alt: null },
      { src: 'https://example.com/2.png', alt: null },
      { src: 'https://example.com/3.png', alt: 'ok' },
    ],
  }, 'img-alt-missing')
  assertEquals(f?.severity, 'high')
  assertStringIncludes(f?.evidence ?? '', '1.png')
  assertEquals(find({ images: [] }, 'img-alt-missing'), undefined)
})

// ---------------------------------------------------------------------------
// Content — the SPA distinction
// ---------------------------------------------------------------------------

Deno.test('js-only-content fires on an empty SPA shell', () => {
  const findings = runChecks(
    { wordCount: 12, scriptCount: 9, textHtmlRatio: 0.01 } as Digest,
    null,
    null,
  )
  const f = findings.find((x) => x.id === 'js-only-content')
  assertEquals(f?.severity, 'critical')
  assertEquals(f?.dimension, 'content')
  assertStringIncludes(f?.evidence ?? '', '12')
  assertStringIncludes(f?.evidence ?? '', '9')
})

Deno.test('js-only-content does not fire on a normal script-using page', () => {
  const findings = runChecks(
    { wordCount: 1400, scriptCount: 8, textHtmlRatio: 0.28 } as Digest,
    null,
    null,
  )
  assertEquals(findings.find((x) => x.id === 'js-only-content'), undefined)
})

Deno.test('js-only-content keys on text absence, not script count', () => {
  // 60 scripts, plenty of text: a heavy but real page. Must stay quiet.
  assertEquals(
    ids({ wordCount: 2000, scriptCount: 60, textHtmlRatio: 0.22 }).includes('js-only-content'),
    false,
  )
  // A tiny page with no scripts is thin, not JavaScript-dependent.
  const noScripts = ids({ wordCount: 20, scriptCount: 0, textHtmlRatio: 0.4 })
  assertEquals(noScripts.includes('js-only-content'), false)
  assertEquals(noScripts.includes('thin-content'), true)
})

Deno.test('thin-content', () => {
  assertEquals(find({ wordCount: 220, textHtmlRatio: 0.2 }, 'thin-content')?.severity, 'medium')
  assertEquals(find({ wordCount: 80, textHtmlRatio: 0.2 }, 'thin-content')?.severity, 'high')
  assertEquals(find({}, 'thin-content'), undefined)
})

Deno.test('thin-content stands down when js-only-content already explains the emptiness', () => {
  const found = ids({ wordCount: 12, scriptCount: 9, textHtmlRatio: 0.01 })
  assertEquals(found.includes('js-only-content'), true)
  assertEquals(found.includes('thin-content'), false)
})

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

Deno.test('jsonld-invalid', () => {
  const f = find({
    jsonLd: [{ valid: false, types: [], raw: '{"@type":"Recipe",}' }],
  }, 'jsonld-invalid')
  assertEquals(f?.severity, 'high')
  assertStringIncludes(f?.evidence ?? '', '@type')
  assertEquals(find({}, 'jsonld-invalid'), undefined)
})

Deno.test('jsonld-missing', () => {
  assertEquals(find({ jsonLd: [] }, 'jsonld-missing')?.severity, 'low')
  assertEquals(find({}, 'jsonld-missing'), undefined)
  // An invalid block is not a missing block.
  assertEquals(
    ids({ jsonLd: [{ valid: false, types: [], raw: '{' }] }).includes('jsonld-missing'),
    false,
  )
})

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

Deno.test('generic-anchor-text', () => {
  const generic = ['click here', 'read more', 'Learn More', 'here'].map((text, i) => ({
    href: `https://example.com/${i}`,
    text,
    rel: null,
    internal: true,
  }))
  const f = find({ links: generic }, 'generic-anchor-text')
  assertEquals(f?.severity, 'low')
  assertStringIncludes(f?.evidence ?? '', 'click here')
  assertEquals(find({}, 'generic-anchor-text'), undefined)
})

// ---------------------------------------------------------------------------
// Answer-engine readiness
// ---------------------------------------------------------------------------

const PROSE_ONLY: Partial<Digest> = {
  lists: 0,
  listItems: 0,
  tables: 0,
  mainListItems: 0,
  mainTables: 0,
  questionHeadings: 0,
}

Deno.test('no-extractable-answers', () => {
  const f = find({ ...PROSE_ONLY, headings: [{ level: 1, text: 'Our company' }] }, 'no-extractable-answers')
  assertEquals(f?.severity, 'medium')
  assertEquals(f?.dimension, 'answer-engine')
  assertEquals(find({}, 'no-extractable-answers'), undefined)
})

Deno.test('no-extractable-answers stays quiet on a page too short to judge', () => {
  assertEquals(
    ids({ ...PROSE_ONLY, wordCount: 120 }).includes('no-extractable-answers'),
    false,
  )
})

/**
 * The regression this check exists to survive.
 *
 * Keyed on the document-wide `listItems`, this could not fire on any page with
 * a navigation menu — which is every page — because eight `<li>` in a nav read
 * as "the content is well structured". It was covered by tests that set
 * `listItems: 0` by hand, so the suite was green and the check was dead.
 */
Deno.test('no-extractable-answers reads content lists, not the navigation menu', () => {
  const withNav = find({
    ...PROSE_ONLY,
    lists: 2,
    listItems: 11, //     a nav and a footer menu
    mainListItems: 0, //  nothing structured in the content itself
  }, 'no-extractable-answers')
  assertEquals(withNav?.severity, 'medium')
  assertStringIncludes(withNav?.evidence ?? '', 'outside the navigation')

  // Genuinely structured content still stands the check down.
  assertEquals(
    find({ ...PROSE_ONLY, listItems: 11, mainListItems: 6 }, 'no-extractable-answers'),
    undefined,
  )
})

// ---------------------------------------------------------------------------
// Coverage and robustness
// ---------------------------------------------------------------------------

// Read from the module rather than restated here. A second copy of this list is
// a copy that drifts, and the catalogue is now load-bearing in three places:
// the passed-checks list, merge's authority rule, and this assertion.
const ALL_IDS = CHECK_CATALOGUE.map((c) => c.id)

Deno.test('the worst possible page fires every check except the mutually exclusive pair', () => {
  const awful = runChecks(
    healthy({
      title: null,
      description: null,
      canonical: 'https://cdn.other.test/x',
      robotsMeta: 'noindex',
      redirects: ['https://example.com/a', 'https://example.com/b', 'https://example.com/page'],
      headings: [{ level: 2, text: 'Only' }, { level: 5, text: 'Deep' }],
      lang: null,
      viewport: null,
      images: [{ src: 'https://example.com/x.png', alt: null }],
      wordCount: 10,
      scriptCount: 20,
      textHtmlRatio: 0.005,
      jsonLd: [{ valid: false, types: [], raw: '{' }],
      links: ['click here', 'read more', 'more', 'here'].map((text, i) => ({
        href: `https://example.com/${i}`,
        text,
        rel: null,
        internal: true,
      })),
      ...PROSE_ONLY,
    }),
    'User-agent: *\nDisallow: /page\n',
    null,
  ).map((f) => f.id)

  // canonical-missing / title-length / description-length / h1-multiple /
  // thin-content / jsonld-missing / no-extractable-answers are all excluded by
  // a stronger finding on the same subject, which is the point.
  for (
    const id of [
      'title-missing',
      'description-missing',
      'canonical-mismatch',
      'noindex-present',
      'robots-blocked',
      'sitemap-missing',
      'redirect-chain',
      'h1-missing',
      'heading-skip',
      'lang-missing',
      'viewport-missing',
      'img-alt-missing',
      'js-only-content',
      'jsonld-invalid',
      'generic-anchor-text',
    ]
  ) {
    assertEquals(awful.includes(id), true, `expected ${id}`)
  }
})

Deno.test('every emitted id is one of the documented ids', () => {
  const seen = new Set<string>()
  const digests: Partial<Digest>[] = [
    {},
    { title: null, description: null, canonical: null, lang: null, viewport: null },
    { wordCount: 10, scriptCount: 9, textHtmlRatio: 0.01 },
    { wordCount: 200 },
    { headings: [] },
    { headings: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }, { level: 4, text: 'c' }] },
    { images: [{ src: 'https://example.com/a.png', alt: null }] },
    { jsonLd: [] },
    { jsonLd: [{ valid: false, types: [], raw: '{' }] },
    { canonical: 'https://other.test/x' },
    { redirects: ['https://a.test/', 'https://b.test/', 'https://c.test/'] },
    PROSE_ONLY,
    { title: 'x', description: 'y' },
    { title: 'x'.repeat(200), description: 'y'.repeat(400) },
    { status: 404 },
    { status: 503 },
    { truncated: true, wordCount: 40, textHtmlRatio: 0.4 },
  ]
  for (const partial of digests) {
    for (const f of runChecks(healthy(partial), 'User-agent: *\nDisallow: /page', null)) {
      seen.add(f.id)
    }
  }
  for (const id of seen) assertEquals(ALL_IDS.includes(id), true, `undocumented id ${id}`)
})

Deno.test('runChecks tolerates a sparse digest without throwing', () => {
  const sparse: Partial<Digest>[] = [
    {},
    { title: 'x' },
    { headings: [] },
    { links: [] },
    { images: [] },
    { jsonLd: [] },
  ]
  for (const partial of sparse) {
    const findings = runChecks(partial as Digest, null, null)
    assertEquals(Array.isArray(findings), true)
  }
  assertEquals(Array.isArray(runChecks(undefined as unknown as Digest, null, null)), true)
})

// ---------------------------------------------------------------------------
// HTTP status — reviewing an error page as if it were the page
// ---------------------------------------------------------------------------

Deno.test('http-status-error fires on 4xx and 5xx and says the rest was measured against an error page', () => {
  const notFound = find({ status: 404 }, 'http-status-error')
  assertEquals(notFound?.severity, 'critical')
  assertEquals(notFound?.dimension, 'crawlability')
  assertStringIncludes(notFound?.evidence ?? '', '404')
  assertStringIncludes(notFound?.fix ?? '', 'error page')

  assertStringIncludes(find({ status: 503 }, 'http-status-error')?.fix ?? '', 'server error')
  assertEquals(find({ status: 200 }, 'http-status-error'), undefined)
  assertEquals(find({ status: 204 }, 'http-status-error'), undefined)
})

Deno.test('a status we never observed is not a status finding', () => {
  // 0 is the "no transport metadata" default, not a failed request.
  assertEquals(find({ status: 0 }, 'http-status-error'), undefined)
  assertEquals(review(healthy({ status: 0 }), ROBOTS, SITEMAP).passed.includes('http-status-error'), false)
})

// ---------------------------------------------------------------------------
// Truncation — a floor is not a measurement
// ---------------------------------------------------------------------------

Deno.test('thin-content is neither fired nor cleared when the body was truncated', () => {
  const cut = review(healthy({ truncated: true, wordCount: 40 }), ROBOTS, SITEMAP)
  assertEquals(cut.findings.some((f) => f.id === 'thin-content'), false)
  assertEquals(cut.passed.includes('thin-content'), false)

  // The same page read in full is genuinely thin, and says so.
  const whole = review(healthy({ truncated: false, wordCount: 40 }), ROBOTS, SITEMAP)
  assertEquals(whole.findings.find((f) => f.id === 'thin-content')?.severity, 'high')
})

Deno.test('js-only-content on a truncated body reports the truncation as part of the argument', () => {
  const f = find({
    truncated: true,
    wordCount: 4,
    scriptCount: 3,
    textHtmlRatio: 0.001,
    htmlLength: 2_097_152,
  }, 'js-only-content')
  assertEquals(f?.severity, 'critical')
  assertStringIncludes(f?.evidence ?? '', 'size cap')
})

// ---------------------------------------------------------------------------
// Noise control — what a normal, well-built page is not scolded for
// ---------------------------------------------------------------------------

Deno.test('a missing canonical is soft on a clean URL and firm on a duplicable one', () => {
  assertEquals(find({ canonical: null }, 'canonical-missing')?.severity, 'low')

  const withQuery = find({
    canonical: null,
    finalUrl: 'https://example.com/page?utm_source=news&ref=x',
  }, 'canonical-missing')
  assertEquals(withQuery?.severity, 'medium')
  assertStringIncludes(withQuery?.evidence ?? '', 'utm_source')

  assertEquals(
    find({ canonical: null, redirects: ['https://example.com/page'] }, 'canonical-missing')?.severity,
    'medium',
  )
})

Deno.test('a bare http→https upgrade is not a redirect chain', () => {
  // What a correctly configured site does when someone types the address.
  assertEquals(
    find({
      url: 'http://example.com/page',
      redirects: ['https://example.com/page', 'https://example.com/page/'],
    }, 'redirect-chain'),
    undefined,
  )

  // Two hops that actually move the page still count.
  assertEquals(
    find({
      url: 'https://example.com/old',
      redirects: ['https://example.com/new', 'https://example.com/newer'],
    }, 'redirect-chain')?.severity,
    'medium',
  )
})

Deno.test('one un-described image among many is a low finding, not a medium one', () => {
  const many = (missing: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({
      src: `https://example.com/${i}.png`,
      alt: i < missing ? null : 'described',
    }))

  assertEquals(find({ images: many(1, 30) }, 'img-alt-missing')?.severity, 'low')
  assertEquals(find({ images: many(5, 30) }, 'img-alt-missing')?.severity, 'medium')
  assertEquals(find({ images: many(9, 30) }, 'img-alt-missing')?.severity, 'medium')
  assertEquals(find({ images: many(20, 30) }, 'img-alt-missing')?.severity, 'high')
})

Deno.test('a shell page is not also told to add structured data', () => {
  // It has no content to describe; js-only-content already said the only thing
  // worth saying, and stacking schema advice on top is the duplicate scolding
  // that makes these reports unreadable.
  const shell = ids({ wordCount: 8, scriptCount: 6, textHtmlRatio: 0.004, jsonLd: [] })
  assertEquals(shell.includes('js-only-content'), true)
  assertEquals(shell.includes('jsonld-missing'), false)

  assertEquals(ids({ jsonLd: [] }).includes('jsonld-missing'), true)
})

Deno.test('sitemap-missing never claims to know what an unreadable robots.txt says', () => {
  const unread = find({}, 'sitemap-missing', null, null)
  assertStringIncludes(unread?.evidence ?? '', 'robots.txt could not be read')
  assertEquals(unread?.severity, 'low')

  const read = find({}, 'sitemap-missing', 'User-agent: *\nAllow: /\n', null)
  assertStringIncludes(read?.evidence ?? '', 'declares no Sitemap: line')

  // Either a real sitemap or a Sitemap: line in robots.txt stands it down.
  assertEquals(find({}, 'sitemap-missing', 'User-agent: *\nAllow: /\n', SITEMAP), undefined)
  assertEquals(find({}, 'sitemap-missing', ROBOTS, null), undefined)
})

// ---------------------------------------------------------------------------
// The passed list — what makes a clean report legible
// ---------------------------------------------------------------------------

Deno.test('a clean page reports every applicable check as passed and none as failed', () => {
  const { findings, passed } = review(healthy(), ROBOTS, SITEMAP)
  assertEquals(findings, [])
  assertEquals(passed.length > 15, true, `only ${passed.length} checks reported`)
  for (const id of passed) assertEquals(CHECK_IDS.has(id), true, `unknown id ${id}`)
})

Deno.test('a check is only reported as passed when the page gave it something to decide', () => {
  const noTitle = review(healthy({ title: null }), ROBOTS, SITEMAP)
  assertEquals(noTitle.findings.some((f) => f.id === 'title-missing'), true)
  // There is no title to measure, so the length check did not run.
  assertEquals(noTitle.passed.includes('title-length'), false)

  const noCanonical = review(healthy({ canonical: null }), ROBOTS, SITEMAP)
  assertEquals(noCanonical.passed.includes('canonical-mismatch'), false)

  const noImages = review(healthy({ images: [] }), ROBOTS, SITEMAP)
  assertEquals(noImages.passed.includes('img-alt-missing'), false)

  const noLinks = review(healthy({ links: [] }), ROBOTS, SITEMAP)
  assertEquals(noLinks.passed.includes('generic-anchor-text'), false)

  // robots.txt we could not read has not cleared anything for crawling.
  assertEquals(review(healthy(), null, SITEMAP).passed.includes('robots-blocked'), false)
  assertEquals(review(healthy(), ROBOTS, SITEMAP).passed.includes('robots-blocked'), true)
})

Deno.test('passed and failed are disjoint, always', () => {
  const cases: Partial<Digest>[] = [
    {},
    { title: null, description: null, canonical: null, lang: null, viewport: null },
    { status: 404 },
    { wordCount: 10, scriptCount: 9, textHtmlRatio: 0.01 },
    { truncated: true, wordCount: 5 },
    PROSE_ONLY,
  ]
  for (const partial of cases) {
    const { findings, passed } = review(healthy(partial), ROBOTS, SITEMAP)
    const failed = new Set(findings.map((f) => f.id))
    for (const id of passed) {
      assertEquals(failed.has(id), false, `${id} is reported as both passed and failed`)
    }
  }
})

Deno.test('every catalogue entry is reachable, and every fired id is in the catalogue', () => {
  // A catalogue entry no check can produce is a promise the report cannot keep;
  // a fired id with no entry has no label and would render as a bare slug.
  const seen = new Set<string>()
  const digests: Partial<Digest>[] = [
    {},
    { status: 500 },
    { robotsMeta: 'noindex' },
    { canonical: 'https://other.test/x' },
    { canonical: null },
    { redirects: ['https://a.test/x', 'https://b.test/y'] },
    { title: null },
    { title: 'short' },
    { description: null },
    { description: 'short' },
    { wordCount: 8, scriptCount: 6, textHtmlRatio: 0.004 },
    { wordCount: 100 },
    { headings: [] },
    { headings: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }] },
    { headings: [{ level: 1, text: 'a' }, { level: 4, text: 'b' }] },
    { lang: null },
    { viewport: null },
    { images: [{ src: 'https://example.com/a.png', alt: null }] },
    { jsonLd: [{ valid: false, types: [], raw: '{' }] },
    { jsonLd: [] },
    {
      links: ['click here', 'read more', 'here'].map((text) => ({
        href: 'https://example.com/x',
        text,
        rel: null,
        internal: true,
      })),
    },
    PROSE_ONLY,
  ]
  for (const partial of digests) {
    for (const f of runChecks(healthy(partial), 'User-agent: *\nDisallow: /page', null)) {
      seen.add(f.id)
    }
  }
  for (const entry of CHECK_CATALOGUE) {
    assertEquals(seen.has(entry.id), true, `no digest above makes ${entry.id} fire`)
  }
  for (const id of seen) assertEquals(CHECK_IDS.has(id), true, `undocumented id ${id}`)
})

Deno.test('the catalogue has no duplicate ids and every entry has a passing sentence', () => {
  assertEquals(CHECK_IDS.size, CHECK_CATALOGUE.length)
  for (const entry of CHECK_CATALOGUE) {
    assertEquals(entry.passed.trim().length > 0, true, entry.id)
    assertEquals(entry.id, entry.id.toLowerCase().replace(/[^a-z0-9-]/g, ''))
  }
})
