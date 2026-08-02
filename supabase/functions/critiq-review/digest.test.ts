import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildDigest } from './digest.ts'

const meta = (over: Record<string, unknown> = {}) => ({
  url: 'https://example.com/page',
  finalUrl: 'https://example.com/page',
  status: 200,
  redirects: [] as string[],
  elapsedMs: 120,
  ...over,
})

// ---------------------------------------------------------------------------
// Head metadata
// ---------------------------------------------------------------------------

const FULL = `<!doctype html>
<html lang="en-GB">
<head>
  <title>  How to bake sourdough  </title>
  <meta name="description" content="A practical guide to sourdough.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="/page">
  <link rel="alternate" hreflang="fr" href="https://example.com/fr/page">
  <link rel="alternate" hreflang="x-default" href="https://example.com/page">
  <meta property="og:title" content="Sourdough">
  <meta property="og:image" content="https://example.com/og.png">
  <meta name="twitter:card" content="summary_large_image">
</head>
<body>
  <h1>How to bake sourdough</h1>
  <p>Mix flour and water. Wait. Bake it in a very hot oven.</p>
</body>
</html>`

Deno.test('extracts head metadata', () => {
  const d = buildDigest(FULL, meta())
  assertEquals(d.title, 'How to bake sourdough')
  assertEquals(d.description, 'A practical guide to sourdough.')
  assertEquals(d.viewport, 'width=device-width, initial-scale=1')
  assertEquals(d.robotsMeta, 'index, follow')
  assertEquals(d.lang, 'en-GB')
  // Relative canonicals are resolved against the final URL so `canonical-mismatch`
  // compares like with like.
  assertEquals(d.canonical, 'https://example.com/page')
  assertEquals(d.og.title, 'Sourdough')
  assertEquals(d.og.image, 'https://example.com/og.png')
  assertEquals(d.twitter.card, 'summary_large_image')
  assertEquals(d.hreflang.length, 2)
  assertEquals(d.hreflang[0], { lang: 'fr', href: 'https://example.com/fr/page' })
})

Deno.test('reports absent metadata as null rather than empty string', () => {
  const d = buildDigest('<html><body><p>hello</p></body></html>', meta())
  assertEquals(d.title, null)
  assertEquals(d.description, null)
  assertEquals(d.canonical, null)
  assertEquals(d.robotsMeta, null)
  assertEquals(d.lang, null)
  assertEquals(d.viewport, null)
  assertEquals(d.og, {})
  assertEquals(d.twitter, {})
})

Deno.test('reads X-Robots-Tag from the response headers', () => {
  const headers = new Headers({ 'x-robots-tag': 'noindex, nofollow' })
  const d = buildDigest(FULL, meta({ headers }))
  assertEquals(d.xRobotsTag, 'noindex, nofollow')
})

Deno.test('carries transport metadata through unchanged', () => {
  const d = buildDigest(FULL, meta({
    url: 'http://example.com/page',
    finalUrl: 'https://example.com/page',
    status: 200,
    redirects: ['https://example.com/page'],
    elapsedMs: 431,
  }))
  assertEquals(d.url, 'http://example.com/page')
  assertEquals(d.finalUrl, 'https://example.com/page')
  assertEquals(d.redirects, ['https://example.com/page'])
  assertEquals(d.elapsedMs, 431)
  assertEquals(d.status, 200)
})

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

Deno.test('records every heading in document order, including multiple H1s', () => {
  const d = buildDigest(
    `<body>
       <h1>First</h1>
       <h2>Second</h2>
       <h1>Another top level</h1>
       <h3>Third</h3>
     </body>`,
    meta(),
  )
  assertEquals(d.headings, [
    { level: 1, text: 'First' },
    { level: 2, text: 'Second' },
    { level: 1, text: 'Another top level' },
    { level: 3, text: 'Third' },
  ])
})

Deno.test('preserves a level skip rather than repairing it', () => {
  const d = buildDigest('<body><h1>A</h1><h4>D</h4></body>', meta())
  assertEquals(d.headings.map((h) => h.level), [1, 4])
})

Deno.test('collapses whitespace inside heading text', () => {
  const d = buildDigest('<body><h2>\n  Two   words\n</h2></body>', meta())
  assertEquals(d.headings[0]?.text, 'Two words')
})

Deno.test('counts headings phrased as questions, for answer-engine readiness', () => {
  const d = buildDigest(
    `<body>
       <h1>Sourdough</h1>
       <h2>What is a starter?</h2>
       <h2>How long should it proof</h2>
       <h2>Equipment</h2>
     </body>`,
    meta(),
  )
  assertEquals(d.questionHeadings, 2)
})

// ---------------------------------------------------------------------------
// Images — the empty/missing alt distinction
// ---------------------------------------------------------------------------

Deno.test('distinguishes an empty alt from a missing one', () => {
  const d = buildDigest(
    `<body>
       <img src="/a.png" alt="A loaf of bread">
       <img src="/spacer.gif" alt="">
       <img src="/c.png">
     </body>`,
    meta(),
  )
  assertEquals(d.images.length, 3)
  assertEquals(d.images[0]?.alt, 'A loaf of bread')
  // Empty alt is the correct markup for a decorative image. Conflating it with
  // a missing attribute would flag every well-built page.
  assertEquals(d.images[1]?.alt, '')
  assertEquals(d.images[2]?.alt, null)
  assertEquals(d.images.filter((i) => i.alt === null).length, 1)
})

Deno.test('resolves image sources against the final URL and falls back to data-src', () => {
  const d = buildDigest(
    '<body><img src="/a.png"><img data-src="/lazy.png"></body>',
    meta({ finalUrl: 'https://example.com/blog/post' }),
  )
  assertEquals(d.images[0]?.src, 'https://example.com/a.png')
  assertEquals(d.images[1]?.src, 'https://example.com/lazy.png')
})

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

Deno.test('classifies links as internal or external and records rel', () => {
  const d = buildDigest(
    `<body>
       <a href="/about">About us</a>
       <a href="https://example.com/pricing">Pricing</a>
       <a href="https://other.test/x" rel="nofollow noopener">Sponsor</a>
       <a href="https://other.test/y">Reference</a>
       <a href="mailto:a@b.c">Email</a>
       <a href="#top">Back to top</a>
       <a>No href at all</a>
     </body>`,
    meta(),
  )
  const byText = Object.fromEntries(d.links.map((l) => [l.text, l]))
  assertEquals(byText['About us']?.internal, true)
  assertEquals(byText['About us']?.href, 'https://example.com/about')
  assertEquals(byText['Pricing']?.internal, true)
  assertEquals(byText['Sponsor']?.internal, false)
  assertEquals(byText['Sponsor']?.rel, 'nofollow noopener')
  assertEquals(byText['Reference']?.rel, null)
  // mailto: and href-less anchors are not links a crawler follows.
  assertEquals(byText['Email'], undefined)
  assertEquals(byText['No href at all'], undefined)
  assertEquals(d.internalLinks, 3) // /about, /pricing, #top
  assertEquals(d.externalLinks, 2)
})

Deno.test('records empty anchor text as an empty string', () => {
  const d = buildDigest('<body><a href="/x"><img src="/i.png" alt=""></a></body>', meta())
  assertEquals(d.links[0]?.text, '')
})

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

Deno.test('parses JSON-LD and reports the types found', () => {
  const d = buildDigest(
    `<body><script type="application/ld+json">
       {"@context":"https://schema.org","@type":"Recipe","name":"Sourdough"}
     </script></body>`,
    meta(),
  )
  assertEquals(d.jsonLd.length, 1)
  assertEquals(d.jsonLd[0]?.valid, true)
  assertEquals(d.jsonLd[0]?.types, ['Recipe'])
})

Deno.test('flattens @graph and arrays when collecting types', () => {
  const d = buildDigest(
    `<body>
      <script type="application/ld+json">
        {"@graph":[{"@type":"Organization"},{"@type":["WebSite","CreativeWork"]}]}
      </script>
      <script type="application/ld+json">[{"@type":"BreadcrumbList"}]</script>
    </body>`,
    meta(),
  )
  assertEquals(d.jsonLd[0]?.types, ['Organization', 'WebSite', 'CreativeWork'])
  assertEquals(d.jsonLd[1]?.types, ['BreadcrumbList'])
})

Deno.test('marks malformed JSON-LD invalid instead of throwing', () => {
  const d = buildDigest(
    `<body><script type="application/ld+json">{"@type":"Recipe",}</script></body>`,
    meta(),
  )
  assertEquals(d.jsonLd.length, 1)
  assertEquals(d.jsonLd[0]?.valid, false)
  assertEquals(d.jsonLd[0]?.types, [])
  // The raw block is kept so the finding can show the reader what broke.
  assertStringIncludes(d.jsonLd[0]?.raw ?? '', '"@type":"Recipe",')
})

Deno.test('reports no JSON-LD as an empty array', () => {
  assertEquals(buildDigest('<body><p>x</p></body>', meta()).jsonLd, [])
})

// ---------------------------------------------------------------------------
// Content volume — the SPA-shell signal
// ---------------------------------------------------------------------------

const SPA_SHELL = `<!doctype html><html lang="en"><head>
<title>My App</title><meta name="viewport" content="width=device-width"></head>
<body><div id="root"></div>
<script src="/assets/vendor.js"></script>
<script src="/assets/index.js"></script>
<script src="/assets/router.js"></script>
<script src="/assets/analytics.js"></script>
<script>window.__PRELOAD__={"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}</script>
<script src="/assets/polyfills.js"></script>
<script src="/assets/sentry.js"></script>
<script src="/assets/intl.js"></script>
<script src="/assets/chunk-abc123.js"></script>
</body></html>`

Deno.test('a client-rendered shell produces near-zero words and a high script count', () => {
  const d = buildDigest(SPA_SHELL, meta())
  assertEquals(d.wordCount < 5, true, `wordCount was ${d.wordCount}`)
  assertEquals(d.scriptCount, 9)
  assertEquals(d.textHtmlRatio < 0.05, true, `ratio was ${d.textHtmlRatio}`)
  assertEquals(d.mainText.trim(), '')
})

Deno.test('script and style text never counts as page content', () => {
  const d = buildDigest(
    `<body>
       <style>.a{color:red}.b{color:blue}.c{color:green}</style>
       <script>const words = "one two three four five six seven eight nine ten"</script>
       <noscript>Please enable JavaScript to view this site.</noscript>
       <p>Only these five words count.</p>
     </body>`,
    meta(),
  )
  assertEquals(d.wordCount, 5)
  assertStringIncludes(d.mainText, 'Only these five words count.')
  assertEquals(d.mainText.includes('const words'), false)
  assertEquals(d.noscriptTextLength > 0, true)
})

Deno.test('a real content page has a healthy text-to-HTML ratio', () => {
  const paragraph = '<p>' + 'sourdough bread needs time and warmth. '.repeat(40) + '</p>'
  const d = buildDigest(`<body><main>${paragraph.repeat(5)}</main></body>`, meta())
  assertEquals(d.wordCount > 1000, true, `wordCount was ${d.wordCount}`)
  assertEquals(d.textHtmlRatio > 0.5, true, `ratio was ${d.textHtmlRatio}`)
})

Deno.test('does not count JSON-LD blocks as executable scripts', () => {
  const d = buildDigest(
    `<body>
       <script type="application/ld+json">{"@type":"Thing"}</script>
       <script src="/a.js"></script>
     </body>`,
    meta(),
  )
  assertEquals(d.scriptCount, 1)
})

// ---------------------------------------------------------------------------
// mainText
// ---------------------------------------------------------------------------

Deno.test('prefers <main> over chrome when extracting the text for the judge', () => {
  const d = buildDigest(
    `<body>
       <nav>Home Pricing Contact Blog Careers</nav>
       <main><p>The actual argument of the page lives here.</p></main>
       <footer>Copyright notice and a long list of legal links</footer>
     </body>`,
    meta(),
  )
  assertEquals(d.mainText, 'The actual argument of the page lives here.')
})

Deno.test('falls back to <article>, then the body', () => {
  const withArticle = buildDigest(
    '<body><nav>Nav</nav><article><p>Article body.</p></article></body>',
    meta(),
  )
  assertEquals(withArticle.mainText, 'Article body.')

  const bare = buildDigest('<body><p>Just a body.</p></body>', meta())
  assertEquals(bare.mainText, 'Just a body.')
})

Deno.test('caps mainText so one page cannot blow the token budget', () => {
  const d = buildDigest(`<body><main><p>${'word '.repeat(5000)}</p></main></body>`, meta())
  assertEquals(d.mainText.length <= 6000, true, `length was ${d.mainText.length}`)
})

// ---------------------------------------------------------------------------
// Answer-engine structure signals
// ---------------------------------------------------------------------------

Deno.test('counts lists, list items, tables and paragraphs', () => {
  const d = buildDigest(
    `<body>
       <ul><li>one</li><li>two</li></ul>
       <ol><li>three</li></ol>
       <table><tr><td>cell</td></tr></table>
       <p>a</p><p>b</p>
     </body>`,
    meta(),
  )
  assertEquals(d.lists, 2)
  assertEquals(d.listItems, 3)
  assertEquals(d.tables, 1)
  assertEquals(d.paragraphs, 2)
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

Deno.test('survives empty and malformed documents', () => {
  for (const html of ['', '   ', '<html', '<body><p>unclosed', '<!doctype html>']) {
    const d = buildDigest(html, meta())
    assertEquals(typeof d.wordCount, 'number')
    assertEquals(Number.isFinite(d.textHtmlRatio), true)
    assertEquals(Array.isArray(d.headings), true)
  }
})

Deno.test('tolerates a canonical or hreflang href that is not a valid URL', () => {
  const d = buildDigest(
    '<head><link rel="canonical" href="http://[not a url"></head>',
    meta(),
  )
  assertEquals(d.canonical, 'http://[not a url')
})
