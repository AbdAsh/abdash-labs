/**
 * critiq-review — the whole review, one round trip.
 *
 * The order below is load-bearing and deliberate:
 *
 *   preflight → getCaller → cache lookup by (url, today) → assertPublicUrl →
 *   consumeQuota on a cache MISS only → guardedFetch → robots.txt + sitemap
 *   → buildDigest → review → judge → mergeFindings → gradeDimensions → insert
 *
 * Two orderings here are decisions rather than habit:
 *
 *  - **Cache before quota.** Resubmitting the same page is genuinely free, as
 *    the spec promises. Reversing these would charge a user for a report we
 *    already have, on a tier that allows one review a day.
 *  - **Guard before quota.** `assertPublicUrl` is pure and opens no socket, so
 *    a refused URL costs us nothing — charging a review for a typo like
 *    `localhost` would spend someone's whole day on a request that never left
 *    the box. This does not weaken the guard: it still runs again, per hop,
 *    inside `guardedFetch`.
 */
import { errorResponse, jsonResponse, preflight } from '../_shared/cors.ts'
import { callerClient, getCaller } from '../_shared/auth.ts'
import { consumeQuota } from '../_shared/quota.ts'
import { assertPublicUrl, guardedFetch } from './ssrf.ts'
import { buildDigest } from './digest.ts'
import { type Finding, review } from './checks.ts'
import { judge } from './judge.ts'
import { gradeDimensions, gradeOverall, mergeFindings } from './merge.ts'

const PAGE_MAX_BYTES = 2 * 1024 * 1024
const PAGE_TIMEOUT_MS = 15_000
const SIDECAR_MAX_BYTES = 512 * 1024
const SIDECAR_TIMEOUT_MS = 8_000

/**
 * Where sitemaps actually live. `/sitemap_index.xml` is the Yoast default and
 * therefore an enormous slice of the web; probing only `/sitemap.xml` and then
 * announcing "no sitemap was found" is a claim the tool has not earned.
 */
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml']

// No 0/O/1/I/l: a slug goes in a URL a human may retype.
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const SLUG_LENGTH = 12

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    if (req.method !== 'POST') return jsonResponse({ error: 'Use POST' }, 405)

    const body = await req.json().catch(() => ({}))
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : ''
    if (rawUrl === '') return jsonResponse({ error: 'A url is required' }, 400)

    const caller = await getCaller(req)
    const db = callerClient(caller.jwt)

    // --- cache, before anything is charged ---------------------------------
    const url = cacheKeyFor(rawUrl)
    const cached = await todaysReport(db, caller.userId, url)
    if (cached) return jsonResponse({ ...cached, cached: true })

    // Free, synchronous, opens no socket — so it happens before anything is
    // charged. The guard runs again inside guardedFetch on every hop.
    assertPublicUrl(rawUrl)

    // --- from here the run costs a review ----------------------------------
    await consumeQuota(caller.jwt, 'critiq', 'reviews', 1)

    const page = await guardedFetch(rawUrl, {
      maxBytes: PAGE_MAX_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
    })

    // robots.txt and sitemap.xml are evidence, not permission. Critiq audits one
    // page on its owner's request, so a Disallow is reported as a finding rather
    // than obeyed — obeying it would make the most important crawlability
    // problem invisible.
    const origin = originOf(page.url)
    const [robots, sitemap] = origin
      ? await Promise.all([
        sidecar(`${origin}/robots.txt`, isRobotsTxt),
        firstSitemap(origin),
      ])
      : [null, null]

    const digest = buildDigest(page.body, {
      url: rawUrl,
      finalUrl: page.url,
      status: page.status,
      redirects: page.redirects,
      elapsedMs: page.elapsedMs,
      headers: page.headers,
      truncated: page.truncated,
    })

    const { findings: checks, passed } = review(digest, robots, sitemap)

    // A model outage degrades the report to its deterministic half rather than
    // failing the run and charging the user for nothing.
    let llm: Finding[] = []
    let judgeError: string | null = null
    try {
      llm = await judge(digest, checks.map((c) => c.id))
    } catch (e) {
      judgeError = e instanceof Error ? e.message : String(e)
      console.error('critiq judge failed', judgeError)
    }

    const findings = mergeFindings(checks, llm)
    const grades = { overall: gradeOverall(findings), ...gradeDimensions(findings) }

    // mainText is only there to prompt the model; keeping it would be the
    // largest column in a 30 MB budget for no reader benefit.
    const { mainText: _mainText, ...storedDigest } = digest

    const slug = makeSlug()
    const { error } = await db.schema('critiq').from('reports').insert({
      slug,
      url,
      status: 'complete',
      grades,
      findings,
      digest: {
        ...storedDigest,
        contentType: page.contentType,
        robotsFound: robots !== null,
        sitemapFound: sitemap !== null,
        // What the deterministic engine cleared. Without it a clean report is
        // indistinguishable from a broken one: the reader sees no findings and
        // has no way to know whether anything ran.
        passed,
        judgeError,
      },
    })
    if (error) throw error

    return jsonResponse({ slug, url, grades, findings, passed, cached: false, judgeError })
  } catch (e) {
    return errorResponse(e)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CachedReport {
  slug: string
  url: string
  grades: unknown
  findings: unknown
}

/**
 * The most recent report this caller made for this URL today.
 *
 * Scoped to the caller on purpose: reports are publicly readable by slug, so an
 * unscoped lookup would hand back a stranger's report and leave the submitter
 * with nothing in their own history.
 */
async function todaysReport(
  db: ReturnType<typeof callerClient>,
  ownerId: string,
  url: string,
): Promise<CachedReport | null> {
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)

  const { data, error } = await db
    .schema('critiq')
    .from('reports')
    .select('slug, url, grades, findings')
    .eq('owner_id', ownerId)
    .eq('url', url)
    .eq('status', 'complete')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // A broken cache lookup must not block a review; worst case the user pays a
  // quota unit they would otherwise have kept.
  if (error) {
    console.error('critiq cache lookup failed', error.message)
    return null
  }
  return (data as CachedReport | null) ?? null
}

/**
 * Canonical string for the cache key. Purely syntactic — this makes no security
 * decision, so it does not pre-empt `assertPublicUrl` later in the sequence.
 */
function cacheKeyFor(raw: string): string {
  try {
    const parsed = new URL(raw.trim())
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return raw.trim()
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Best-effort fetch of a companion file. Any failure means "not found". */
async function sidecar(url: string, looksRight: (text: string) => boolean): Promise<string | null> {
  try {
    const res = await guardedFetch(url, {
      contentTypes: 'any',
      maxBytes: SIDECAR_MAX_BYTES,
      timeoutMs: SIDECAR_TIMEOUT_MS,
    })
    if (res.status < 200 || res.status >= 300) return null
    const text = res.body.trim()
    // Plenty of sites answer /sitemap.xml with a 200 HTML "not found" page.
    return text !== '' && looksRight(text) ? res.body : null
  } catch {
    return null
  }
}

/** The first conventional sitemap location that answers with a real sitemap. */
async function firstSitemap(origin: string): Promise<string | null> {
  for (const path of SITEMAP_PATHS) {
    const found = await sidecar(`${origin}${path}`, isSitemapXml)
    if (found !== null) return found
  }
  return null
}

function isRobotsTxt(text: string): boolean {
  // A site that answers /robots.txt with an HTML error page has not told us
  // anything, and treating that page as robots syntax would let a stray
  // "Disallow:" in the copy fabricate a critical finding.
  if (/^\s*<(!doctype|html)\b/i.test(text.trim())) return false
  return /^\s*(user-agent|sitemap|allow|disallow)\s*:/im.test(text)
}

function isSitemapXml(text: string): boolean {
  return /<(urlset|sitemapindex)\b/i.test(text)
}

function makeSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH))
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('')
}
