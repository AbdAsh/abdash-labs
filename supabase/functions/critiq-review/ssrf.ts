/**
 * SSRF guard for Critiq.
 *
 * Critiq fetches attacker-supplied URLs from our own infrastructure. With a raw
 * `fetch` and no browser sandbox in between, this module is the *only* thing
 * standing between a submitted URL and our network — so it is written as a
 * correctness requirement, not as hardening.
 *
 * The three rules it enforces:
 *
 *  1. **Shape.** http(s) only, ports 80/443 only, no embedded credentials.
 *  2. **Address.** Every IP literal, and every address a hostname resolves to,
 *     is checked against the reserved IPv4 and IPv6 ranges — including the ones
 *     that are routinely forgotten: carrier-grade NAT (100.64.0.0/10), the
 *     IPv4-mapped IPv6 forms, and the cloud metadata endpoints.
 *  3. **Per hop.** Redirects are followed manually (`redirect: 'manual'`) and
 *     the full validation runs again on every `Location`, with DNS re-resolved
 *     immediately before each request. Trusting a decision made one hop earlier
 *     is exactly the DNS-rebinding hole.
 *
 * Known limit, stated plainly: re-resolving immediately before the request
 * narrows the rebinding window to the gap between our lookup and the runtime's
 * own lookup inside `fetch`. Closing it completely requires dialling the
 * validated IP directly with a Host header override, which Deno's `fetch`
 * cannot express for TLS. The narrow window is the accepted residual risk.
 */

export class SsrfError extends Error {
  readonly status = 400
  constructor(msg: string) {
    super(`Refusing to fetch this URL: ${msg}`)
    this.name = 'SsrfError'
  }
}

/** Maximum number of redirects followed. Each one is fully revalidated. */
export const MAX_REDIRECTS = 3

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

const USER_AGENT =
  'CritiqBot/1.0 (+https://labs.abdash.net/critiq; SEO review requested by a user)'

// ---------------------------------------------------------------------------
// Hostname rules
// ---------------------------------------------------------------------------

/** Names that always mean "somewhere inside our own perimeter". */
const BLOCKED_HOST_EXACT = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  'metadata', //          OpenStack / older GCE
  'metadata.goog', //     GCP alternate metadata name
  'instance-data', //     EC2 alternate metadata name
])

/**
 * Suffixes that denote private namespaces. `.internal` alone covers
 * `metadata.google.internal`, `*.ec2.internal` and `*.compute.internal`.
 */
const BLOCKED_HOST_SUFFIX = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
]

function normaliseHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '') // a trailing dot is the same name to a resolver
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

/** [network, prefix length] — every reserved IPv4 block we refuse to reach. */
const V4_BLOCKED: readonly (readonly [number, number])[] = [
  [0x00000000, 8], //  0.0.0.0/8        "this network", and the 0.0.0.0 loopback alias
  [0x0a000000, 8], //  10.0.0.0/8       RFC 1918
  [0x64400000, 10], // 100.64.0.0/10    carrier-grade NAT, RFC 6598 — reachable inside
  //                                    many hosting networks, and routinely missed
  [0x7f000000, 8], //  127.0.0.0/8      loopback
  [0xa9fe0000, 16], // 169.254.0.0/16   link-local, incl. 169.254.169.254 metadata
  [0xac100000, 12], // 172.16.0.0/12    RFC 1918
  [0xc0000000, 24], // 192.0.0.0/24     IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24     TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24   6to4 relay anycast
  [0xc0a80000, 16], // 192.168.0.0/16   RFC 1918
  [0xc6120000, 15], // 198.18.0.0/15    benchmarking
  [0xc6336400, 24], // 198.51.100.0/24  TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24   TEST-NET-3
  [0xe0000000, 4], //  224.0.0.0/4      multicast
  [0xf0000000, 4], //  240.0.0.0/4      reserved, incl. 255.255.255.255 broadcast
]

/** Parses one dotted component the way `inet_aton` does: decimal, 0x hex, 0 octal. */
function parseV4Part(part: string): number | null {
  if (part === '') return null
  let radix = 10
  let digits = part
  if (part.length > 2 && (part[0] === '0') && (part[1] === 'x' || part[1] === 'X')) {
    radix = 16
    digits = part.slice(2)
  } else if (part.length > 1 && part[0] === '0') {
    radix = 8
    digits = part.slice(1)
  }
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/
  if (!pattern.test(digits)) return null
  const value = parseInt(digits, radix)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * Converts any `inet_aton`-style IPv4 literal to a 32-bit integer, or null if
 * the string is not an IPv4 literal at all.
 *
 * The short and non-decimal forms matter: `127.1`, `0x7f000001` and
 * `2130706433` all reach loopback, and a checker that only understands
 * dotted-quad decimal waves all three through.
 */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length === 0 || parts.length > 4) return null

  const values: number[] = []
  for (const part of parts) {
    const value = parseV4Part(part)
    if (value === null) return null
    values.push(value)
  }

  // The final component absorbs all remaining bytes: 127.1 === 127.0.0.1.
  const last = values.pop()
  if (last === undefined) return null
  if (last >= Math.pow(256, 4 - values.length)) return null
  for (const v of values) if (v > 255) return null

  let result = last
  for (let i = 0; i < values.length; i++) {
    result += (values[i] as number) * Math.pow(256, 3 - i)
  }
  return result >>> 0
}

function isBlockedV4(value: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (base & mask) >>> 0
  })
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/**
 * Expands an IPv6 literal to eight 16-bit groups, or null if it is not one.
 *
 * Full expansion — rather than a string prefix test — is what catches
 * `0:0:0:0:0:ffff:7f00:1`, which is `::ffff:127.0.0.1` written in a form that
 * `startsWith('::ffff:')` sails straight past.
 */
export function parseIpv6(input: string): number[] | null {
  let s = input.trim().toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  if (s === '' || !s.includes(':')) return null

  // A trailing dotted-quad (`::ffff:127.0.0.1`) becomes two hex groups.
  const lastDot = s.lastIndexOf('.')
  if (lastDot !== -1) {
    const lastColon = s.lastIndexOf(':')
    if (lastColon === -1 || lastColon > lastDot) return null
    const v4 = ipv4ToInt(s.slice(lastColon + 1))
    if (v4 === null) return null
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${
      (v4 & 0xffff).toString(16)
    }`
  }

  const toGroups = (chunk: string): number[] | null => {
    if (chunk === '') return []
    const out: number[] = []
    for (const part of chunk.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }

  const gap = s.indexOf('::')
  if (gap === -1) {
    const groups = toGroups(s)
    return groups !== null && groups.length === 8 ? groups : null
  }
  if (s.indexOf('::', gap + 1) !== -1) return null // only one '::' is legal

  const head = toGroups(s.slice(0, gap))
  const tail = toGroups(s.slice(gap + 2))
  if (head === null || tail === null) return null

  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...Array.from<number>({ length: fill }).fill(0), ...tail]
}

/** `g` is always the eight groups produced by `parseIpv6`. */
function isBlockedV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0] = g
  // Anything with five leading zero groups, in one rule. That single condition
  // covers all of:
  //   ::              unspecified
  //   ::1             loopback
  //   ::ffff:a.b.c.d  IPv4-mapped, which reaches here as g5 === 0xffff
  //   ::a.b.c.d       the deprecated IPv4-compatible form
  // All refused wholesale rather than by decoding the embedded IPv4, because
  // nothing on the public web is legitimately reachable through any of them and
  // re-deriving the address correctly every time is a bug waiting to happen.
  //
  // Written as one condition on purpose: an earlier version had a separate
  // `g5 === 0xffff` branch below a broader one, which was unreachable and
  // implied a check that was not independently doing anything.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) return true

  if (g0 === 0x0064 && g1 === 0xff9b) return true // 64:ff9b::/96 NAT64 — translates to v4
  if ((g0 & 0xfe00) === 0xfc00) return true //       fc00::/7  unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true //       fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true //       fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true //       ff00::/8  multicast
  if (g0 === 0x2002) return true //                  2002::/16 6to4, embeds a v4 address
  if (g0 === 0x2001 && g1 === 0x0000) return true // 2001:0::/32 Teredo, embeds a v4 address

  return false
}

// ---------------------------------------------------------------------------
// Public address classification
// ---------------------------------------------------------------------------

/** True if `input` is an IP literal in a private, loopback or otherwise reserved range. */
export function isBlockedAddress(input: string): boolean {
  const addr = normaliseHost(input)
  if (addr === '') return false

  if (addr.includes(':')) {
    const groups = parseIpv6(addr)
    // Not parseable as IPv6 → it is not an address, so address rules do not
    // apply. Hostname rules and DNS resolution handle it instead.
    return groups === null ? false : isBlockedV6(groups)
  }

  const v4 = ipv4ToInt(addr)
  if (v4 === null) return false // a hostname, not an address literal
  return isBlockedV4(v4)
}

/** True if the host is an IP literal (either family) rather than a name to resolve. */
export function isIpLiteral(host: string): boolean {
  const addr = normaliseHost(host)
  if (addr.includes(':')) return parseIpv6(addr) !== null
  return ipv4ToInt(addr) !== null
}

/**
 * Validates the shape and the literal address of a URL. Throws `SsrfError`.
 * This runs before every request, including every redirect target.
 */
export function assertPublicUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SsrfError('no URL was provided')
  }

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new SsrfError('not a valid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`only http and https are allowed, not ${url.protocol}`)
  }

  // `http://example.com@169.254.169.254/` reads as example.com to a human and
  // resolves to the metadata service. Credentials have no place here anyway.
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('credentials in the URL are not allowed')
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  if (port !== '80' && port !== '443') {
    throw new SsrfError(`only ports 80 and 443 are allowed, not ${port}`)
  }

  const host = normaliseHost(url.hostname)
  if (host === '') throw new SsrfError('the URL has no hostname')

  // A single-label name has no public meaning, but a resolver will happily
  // complete it against the search domain and hand back an intranet host.
  // (`http:///a` normalises to `http://a/`, which is how this arrives.)
  if (!host.includes('.') && !isIpLiteral(host)) {
    throw new SsrfError(`${host} is not a fully-qualified hostname`)
  }

  if (BLOCKED_HOST_EXACT.has(host)) {
    throw new SsrfError(`${host} is an internal hostname`)
  }
  for (const suffix of BLOCKED_HOST_SUFFIX) {
    if (host.endsWith(suffix)) throw new SsrfError(`${host} is an internal hostname`)
  }
  if (isBlockedAddress(host)) {
    throw new SsrfError(`${host} is a private or reserved address`)
  }

  return url
}

/**
 * Checks every address a hostname resolved to. A single private answer in a
 * multi-address response is enough to refuse: we cannot control which one the
 * runtime will actually connect to.
 */
export function assertResolvedAddresses(host: string, addresses: readonly string[]): void {
  if (addresses.length === 0) {
    throw new SsrfError(`${host} resolves to no usable address`)
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`${host} resolves to a private or reserved address (${address})`)
    }
  }
}

/** Resolves A and AAAA records. Fails closed when the runtime has no resolver. */
export async function resolveHostAddresses(host: string): Promise<string[]> {
  const resolver = (Deno as { resolveDns?: typeof Deno.resolveDns }).resolveDns
  if (typeof resolver !== 'function') {
    // Deliberately fatal. Without resolution we cannot tell a public hostname
    // from one pointed at 169.254.169.254, and guessing in the permissive
    // direction is how an SSRF guard becomes decorative.
    throw new SsrfError(
      'DNS resolution is unavailable in this runtime, so this hostname cannot be verified',
    )
  }
  const settled = await Promise.allSettled([
    resolver(host, 'A'),
    resolver(host, 'AAAA'),
  ])
  const out: string[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled') out.push(...result.value)
  }
  return out
}

// ---------------------------------------------------------------------------
// guardedFetch
// ---------------------------------------------------------------------------

export interface GuardedResponse {
  /** The URL actually fetched, after redirects. */
  url: string
  status: number
  headers: Headers
  body: string
  /** Each redirect target, in order. Empty when there were none. */
  redirects: string[]
  elapsedMs: number
  /** True when the body hit `maxBytes` and was cut short. */
  truncated: boolean
  contentType: string
}

export interface GuardedFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  /** Allowed content-type prefixes, or `'any'`. Defaults to HTML only. */
  contentTypes?: string[] | 'any'
}

/**
 * Injectable network primitives. Real callers never pass these; the test suite
 * uses them to drive the redirect and rebinding paths deterministically, which
 * are the parts that most need covering and are otherwise untestable.
 */
export interface GuardedFetchDeps {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  resolve: (host: string) => Promise<string[]>
}

const realDeps: GuardedFetchDeps = {
  fetch: (input, init) => fetch(input as RequestInfo | URL, init),
  resolve: resolveHostAddresses,
}

/** Fetches a URL with the full guard applied. See `guardedFetchWith`. */
export function guardedFetch(
  raw: string,
  opts: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  return guardedFetchWith(realDeps, raw, opts)
}

export async function guardedFetchWith(
  deps: GuardedFetchDeps,
  raw: string,
  opts: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const contentTypes = opts.contentTypes ?? HTML_CONTENT_TYPES

  const started = Date.now()
  // One deadline for the whole operation, not one per hop — otherwise four
  // redirects buy an attacker four times the timeout.
  const signal = AbortSignal.timeout(timeoutMs)

  let current = assertPublicUrl(raw)
  const redirects: string[] = []

  for (;;) {
    await assertHostIsPublic(deps, current)

    const res = await deps.fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en',
      },
    })

    if (REDIRECT_STATUS.has(res.status)) {
      const location = res.headers.get('location')
      await discard(res)

      if (!location) throw new SsrfError('a redirect arrived with no Location header')
      if (redirects.length >= MAX_REDIRECTS) {
        throw new SsrfError(`more than ${MAX_REDIRECTS} redirects`)
      }

      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new SsrfError('a redirect pointed at something that is not a valid URL')
      }
      // Full revalidation, from scratch. The previous hop's verdict says
      // nothing about this one.
      current = assertPublicUrl(next.toString())
      redirects.push(current.toString())
      continue
    }

    const rawContentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const contentType = (rawContentType.split(';')[0] ?? '').trim()
    if (contentTypes !== 'any' && !contentTypes.some((p) => contentType.startsWith(p))) {
      await discard(res)
      throw new SsrfError(
        `expected HTML but the server sent ${contentType || 'no content type'}`,
      )
    }

    const { text, truncated } = await readCapped(res, maxBytes, charsetOf(rawContentType))

    return {
      url: current.toString(),
      status: res.status,
      headers: res.headers,
      body: text,
      redirects,
      elapsedMs: Date.now() - started,
      truncated,
      contentType,
    }
  }
}

/**
 * The last gate before a socket opens. Called immediately before *every*
 * request in the chain, which is what makes redirect-driven rebinding fail.
 */
async function assertHostIsPublic(deps: GuardedFetchDeps, url: URL): Promise<void> {
  const host = normaliseHost(url.hostname)
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfError(`${host} is a private or reserved address`)
    }
    return // nothing to resolve
  }
  assertResolvedAddresses(host, await deps.resolve(host))
}

function charsetOf(contentType: string): string {
  const match = /charset=\s*"?([\w-]+)"?/.exec(contentType)
  const label = match?.[1] ?? 'utf-8'
  try {
    new TextDecoder(label)
    return label
  } catch {
    return 'utf-8'
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // The peer may already have closed; nothing useful to do.
  }
}

/**
 * Reads at most `maxBytes`, then stops pulling. A response is untrusted input:
 * buffering it whole is how one submitted URL turns into an OOM.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  charset: string,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false

  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        break
      }
      if (!value || value.byteLength === 0) continue
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed.
    }
  }

  const size = Math.min(total, maxBytes)
  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= size) break
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, size - offset))
    buffer.set(slice, offset)
    offset += slice.byteLength
  }

  return {
    text: new TextDecoder(charset, { fatal: false }).decode(buffer),
    truncated: !complete,
  }
}
