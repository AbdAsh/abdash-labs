/**
 * HTML → structured digest.
 *
 * Everything downstream — the deterministic checks, the LLM judge, and the
 * stored report — reads this shape and never the raw HTML. Two consequences
 * worth stating:
 *
 *  - Parsing must never throw. A page we cannot fully understand still has to
 *    produce a report; malformed JSON-LD is recorded as invalid, not raised.
 *  - Script and style text is excluded from every content measurement. Counting
 *    a minified bundle as page copy would hide the single most valuable finding
 *    Critiq can make: that the page has no content without JavaScript.
 */
import { DOMParser, type Element } from 'https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts'

export interface Heading {
  level: number
  text: string
}

export interface DigestImage {
  src: string
  /** `null` means the attribute is absent; `''` means an intentional decorative image. */
  alt: string | null
}

export interface DigestLink {
  href: string
  text: string
  rel: string | null
  internal: boolean
}

export interface JsonLdBlock {
  valid: boolean
  types: string[]
  raw: string
}

export interface Digest {
  url: string
  finalUrl: string
  status: number
  redirects: string[]
  elapsedMs: number

  title: string | null
  description: string | null
  canonical: string | null
  robotsMeta: string | null
  googlebotMeta: string | null
  xRobotsTag: string | null

  lang: string | null
  viewport: string | null
  hreflang: { lang: string; href: string }[]
  og: Record<string, string>
  twitter: Record<string, string>

  headings: Heading[]
  images: DigestImage[]
  links: DigestLink[]
  jsonLd: JsonLdBlock[]

  wordCount: number
  textHtmlRatio: number
  scriptCount: number

  // Structure signals the answer-engine dimension reads.
  htmlLength: number
  textLength: number
  lists: number
  listItems: number
  tables: number
  paragraphs: number
  questionHeadings: number
  noscriptTextLength: number
  internalLinks: number
  externalLinks: number

  /** Leading content text, capped, for the judge. */
  mainText: string
}

export interface DigestMeta {
  url: string
  finalUrl?: string
  status?: number
  redirects?: string[]
  elapsedMs?: number
  headers?: Headers | Record<string, string> | null
}

const MAIN_TEXT_CHARS = 6000
const RAW_JSONLD_CHARS = 4000

const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'module',
])

/** Elements whose text is never page content. */
const NON_CONTENT = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed']

const QUESTION_OPENERS =
  /^(what|why|how|when|where|who|whom|whose|which|can|could|should|would|will|do|does|did|is|are|was|were|has|have|am)\b/i

export function buildDigest(html: string, meta: DigestMeta): Digest {
  const url = meta.url
  const finalUrl = meta.finalUrl ?? meta.url
  const base = safeUrl(finalUrl)

  const doc = parse(html)

  const empty = emptyDigest(html, meta, finalUrl)
  if (!doc) return empty

  // ---- head metadata -------------------------------------------------------
  const metaByName = new Map<string, string>()
  const og: Record<string, string> = {}
  const twitter: Record<string, string> = {}

  for (const el of all(doc, 'meta')) {
    const key = (el.getAttribute('name') ?? el.getAttribute('property') ?? '')
      .trim()
      .toLowerCase()
    const content = (el.getAttribute('content') ?? '').trim()
    if (key === '' || content === '') continue

    if (key.startsWith('og:')) og[key.slice(3)] = content
    else if (key.startsWith('twitter:')) twitter[key.slice(8)] = content
    else if (!metaByName.has(key)) metaByName.set(key, content)
  }

  let canonical: string | null = null
  const hreflang: { lang: string; href: string }[] = []
  for (const el of all(doc, 'link')) {
    const rel = (el.getAttribute('rel') ?? '').trim().toLowerCase().split(/\s+/)
    const href = (el.getAttribute('href') ?? '').trim()
    if (href === '') continue
    if (canonical === null && rel.includes('canonical')) canonical = resolve(href, base)
    if (rel.includes('alternate')) {
      const lang = (el.getAttribute('hreflang') ?? '').trim()
      if (lang !== '') hreflang.push({ lang, href: resolve(href, base) })
    }
  }

  // ---- headings ------------------------------------------------------------
  const headings: Heading[] = []
  for (const el of all(doc, 'h1, h2, h3, h4, h5, h6')) {
    const level = Number(el.tagName.slice(1))
    if (!Number.isInteger(level)) continue
    headings.push({ level, text: squash(el.textContent) })
  }
  const questionHeadings = headings.filter((h) =>
    h.text.endsWith('?') || QUESTION_OPENERS.test(h.text)
  ).length

  // ---- images --------------------------------------------------------------
  const images: DigestImage[] = all(doc, 'img').map((el) => {
    const src = (el.getAttribute('src') ?? el.getAttribute('data-src') ??
      firstSrcSet(el.getAttribute('srcset')) ?? '').trim()
    return {
      src: src === '' ? '' : resolve(src, base),
      // getAttribute returns null when absent and '' when `alt=""`. That
      // distinction is the whole point: `alt=""` is correct markup.
      alt: el.getAttribute('alt'),
    }
  })

  // ---- links ---------------------------------------------------------------
  const links: DigestLink[] = []
  let internalLinks = 0
  let externalLinks = 0
  for (const el of all(doc, 'a')) {
    const raw = (el.getAttribute('href') ?? '').trim()
    if (raw === '') continue
    const resolved = safeUrl(raw, base)
    // mailto:, tel:, javascript: — not links a crawler follows.
    if (resolved && resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    if (!resolved && /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue

    const internal = resolved !== null && base !== null && resolved.origin === base.origin
    if (internal) internalLinks++
    else externalLinks++

    links.push({
      href: resolved ? resolved.toString() : raw,
      text: squash(el.textContent),
      rel: el.getAttribute('rel'),
      internal,
    })
  }

  // ---- scripts and JSON-LD -------------------------------------------------
  const jsonLd: JsonLdBlock[] = []
  let scriptCount = 0
  for (const el of all(doc, 'script')) {
    const type = (el.getAttribute('type') ?? '').trim().toLowerCase()
    if (type === 'application/ld+json' || type === 'application/json+ld') {
      jsonLd.push(readJsonLd(el.textContent ?? ''))
      continue
    }
    if (EXECUTABLE_SCRIPT_TYPES.has(type)) scriptCount++
  }

  // ---- structure counts (before stripping, so noscript is still present) ---
  const lists = all(doc, 'ul, ol').length
  const listItems = all(doc, 'li').length
  const tables = all(doc, 'table').length
  const paragraphs = all(doc, 'p').length
  const noscriptTextLength = all(doc, 'noscript')
    .reduce((n, el) => n + squash(el.textContent).length, 0)

  // ---- text ----------------------------------------------------------------
  const mainRoot = pick(doc, ['main', 'article', '[role="main"]', '#content', '.content'])
  strip(doc)

  const bodyText = squash(doc.body?.textContent ?? doc.documentElement?.textContent ?? '')
  const mainText = capWords(
    squash(mainRoot?.textContent ?? '') || bodyText,
    MAIN_TEXT_CHARS,
  )

  const htmlLength = html.length
  const textLength = bodyText.length
  const wordCount = bodyText === '' ? 0 : bodyText.split(/\s+/).filter(Boolean).length

  return {
    ...empty,
    url,
    finalUrl,
    title: nullIfEmpty(squash(doc.querySelector('title')?.textContent ?? '')),
    description: metaByName.get('description') ?? null,
    canonical,
    robotsMeta: metaByName.get('robots') ?? null,
    googlebotMeta: metaByName.get('googlebot') ?? null,
    lang: nullIfEmpty((doc.documentElement?.getAttribute('lang') ?? '').trim()),
    viewport: metaByName.get('viewport') ?? null,
    hreflang,
    og,
    twitter,
    headings,
    images,
    links,
    jsonLd,
    wordCount,
    textHtmlRatio: htmlLength === 0 ? 0 : round(textLength / htmlLength),
    scriptCount,
    htmlLength,
    textLength,
    lists,
    listItems,
    tables,
    paragraphs,
    questionHeadings,
    noscriptTextLength,
    internalLinks,
    externalLinks,
    mainText,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(html: string) {
  try {
    return new DOMParser().parseFromString(html ?? '', 'text/html')
  } catch {
    return null
  }
}

function emptyDigest(html: string, meta: DigestMeta, finalUrl: string): Digest {
  return {
    url: meta.url,
    finalUrl,
    status: meta.status ?? 0,
    redirects: meta.redirects ?? [],
    elapsedMs: meta.elapsedMs ?? 0,
    title: null,
    description: null,
    canonical: null,
    robotsMeta: null,
    googlebotMeta: null,
    xRobotsTag: headerOf(meta.headers, 'x-robots-tag'),
    lang: null,
    viewport: null,
    hreflang: [],
    og: {},
    twitter: {},
    headings: [],
    images: [],
    links: [],
    jsonLd: [],
    wordCount: 0,
    textHtmlRatio: 0,
    scriptCount: 0,
    htmlLength: html.length,
    textLength: 0,
    lists: 0,
    listItems: 0,
    tables: 0,
    paragraphs: 0,
    questionHeadings: 0,
    noscriptTextLength: 0,
    internalLinks: 0,
    externalLinks: 0,
    mainText: '',
  }
}

function all(root: { querySelectorAll: (s: string) => Iterable<unknown> }, sel: string): Element[] {
  try {
    return [...root.querySelectorAll(sel)] as Element[]
  } catch {
    return []
  }
}

function pick(
  doc: { querySelector: (s: string) => unknown },
  selectors: string[],
): Element | null {
  for (const sel of selectors) {
    try {
      const found = doc.querySelector(sel) as Element | null
      if (found) return found
    } catch {
      // An exotic selector the engine dislikes is not worth failing a review over.
    }
  }
  return null
}

/** Removes every element whose text must not count as page content. */
function strip(doc: { querySelectorAll: (s: string) => Iterable<unknown> }): void {
  for (const el of all(doc, NON_CONTENT.join(', '))) {
    try {
      el.remove()
    } catch {
      el.parentNode?.removeChild(el)
    }
  }
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function nullIfEmpty(value: string): string | null {
  return value === '' ? null : value
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}

function safeUrl(raw: string, base?: URL | null): URL | null {
  try {
    return base ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }
}

/** Absolutises a URL, keeping the original text when it cannot be parsed. */
function resolve(raw: string, base: URL | null): string {
  return safeUrl(raw, base)?.toString() ?? raw
}

function firstSrcSet(srcset: string | null): string | null {
  if (!srcset) return null
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0]
  return first && first !== '' ? first : null
}

function headerOf(
  headers: Headers | Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name)
  }
  const record = headers as Record<string, string>
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) return record[key] ?? null
  }
  return null
}

/**
 * Parses one JSON-LD block. Invalid JSON is recorded, not thrown — "your
 * structured data does not parse" is a finding we want to report, and a page
 * with broken markup must still produce a full review.
 */
function readJsonLd(raw: string): JsonLdBlock {
  const trimmed = raw.trim()
  const kept = trimmed.slice(0, RAW_JSONLD_CHARS)
  try {
    return { valid: true, types: collectTypes(JSON.parse(trimmed)), raw: kept }
  } catch {
    return { valid: false, types: [], raw: kept }
  }
}

function collectTypes(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out, depth + 1)
    return out
  }
  const record = node as Record<string, unknown>
  const type = record['@type']
  if (typeof type === 'string' && !out.includes(type)) out.push(type)
  if (Array.isArray(type)) {
    for (const t of type) if (typeof t === 'string' && !out.includes(t)) out.push(t)
  }
  const graph = record['@graph']
  if (graph !== undefined) collectTypes(graph, out, depth + 1)
  return out
}

/** Truncates on a word boundary so the judge never sees a severed token. */
function capWords(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut
}
