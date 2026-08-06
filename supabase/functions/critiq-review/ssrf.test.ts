/**
 * SSRF guard test suite.
 *
 * This is the only thing standing between an attacker-supplied URL and our
 * network, so the suite is deliberately exhaustive: every literal form the URL
 * parser can hand us, every reserved range, and — most importantly — the
 * redirect and DNS paths, where the guard has to re-run rather than trust the
 * decision it already made.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert@1'

import {
  assertPublicUrl,
  assertResolvedAddresses,
  guardedFetchWith,
  isBlockedAddress,
  MAX_REDIRECTS,
  SsrfError,
  UnsupportedContentError,
  type GuardedFetchDeps,
} from './ssrf.ts'

// ---------------------------------------------------------------------------
// Scheme and port validation
// ---------------------------------------------------------------------------

const BLOCKED_SCHEMES = [
  'file:///etc/passwd',
  'gopher://example.com',
  'ftp://example.com',
  'data:text/html,<h1>x',
  'javascript:alert(1)',
  'blob:https://example.com/abc',
  'ws://example.com/',
  'wss://example.com/',
  'chrome://settings',
  'jar:http://example.com!/',
  'dict://example.com:11211/',
  'sftp://example.com/',
  'ldap://example.com/',
  'tftp://example.com/',
]

Deno.test('rejects non-http(s) schemes', () => {
  for (const u of BLOCKED_SCHEMES) {
    assertThrows(() => assertPublicUrl(u), SsrfError, undefined, u)
  }
})

Deno.test('rejects non-80/443 ports', () => {
  for (
    const u of [
      'http://example.com:22/',
      'http://example.com:25/',
      'http://example.com:3306/',
      'http://example.com:6379/',
      'http://example.com:8080/',
      'http://example.com:11211/',
      'https://example.com:8443/',
      'http://example.com:0/',
    ]
  ) {
    assertThrows(() => assertPublicUrl(u), SsrfError, undefined, u)
  }
})

Deno.test('rejects embedded credentials', () => {
  assertThrows(() => assertPublicUrl('http://user:pass@example.com/'), SsrfError)
  assertThrows(() => assertPublicUrl('http://user@example.com/'), SsrfError)
  // The classic confusion payload: looks like it targets example.com, resolves
  // to 169.254.169.254.
  assertThrows(
    () => assertPublicUrl('http://example.com@169.254.169.254/'),
    SsrfError,
  )
})

Deno.test('rejects garbage input', () => {
  for (const u of ['', '   ', 'not a url', '//example.com', 'http://', 'http:///a']) {
    assertThrows(() => assertPublicUrl(u), SsrfError, undefined, JSON.stringify(u))
  }
})

// ---------------------------------------------------------------------------
// Host validation
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS = [
  'http://localhost/',
  'http://LOCALHOST/',
  'http://sub.localhost/',
  'http://127.0.0.1/',
  'http://127.1/', //                     short-form IPv4
  'http://127.0.0.1./', //                trailing dot
  'http://0x7f000001/', //                hex IPv4
  'http://2130706433/', //                decimal IPv4
  'http://0177.0.0.1/', //                octal IPv4
  'http://0.0.0.0/',
  'http://[::1]/',
  'http://[::]/',
  'http://[::ffff:127.0.0.1]/', //        IPv4-mapped IPv6
  'http://[0:0:0:0:0:ffff:7f00:1]/', //   IPv4-mapped IPv6, fully expanded
  'http://[::ffff:169.254.169.254]/',
  'http://[fe80::1]/', //                 link-local
  'http://[fc00::1]/', //                 unique-local
  'http://[fd12:3456:789a::1]/', //       unique-local
  'http://169.254.169.254/latest/meta-data/', // AWS/Azure/DO metadata
  'http://metadata.google.internal/',
  'http://metadata.google.internal./',
  'http://anything.internal/',
  'http://box.local/',
  'http://100.64.0.1/', //                carrier-grade NAT, RFC 6598
  'http://100.100.100.200/', //           Alibaba Cloud metadata (inside CGNAT)
  'http://10.0.0.5/',
  'http://172.16.4.4/',
  'http://192.168.1.1/',
  'http://192.0.0.1/',
  'http://198.18.0.1/',
  'http://224.0.0.1/',
  'http://255.255.255.255/',
  'https://localhost/',
  'http://①②⑦.0.0.1/', //                 unicode digits that normalise to 127.0.0.1
]

Deno.test('rejects loopback, private, link-local and metadata hosts', () => {
  for (const u of BLOCKED_HOSTS) {
    assertThrows(() => assertPublicUrl(u), SsrfError, undefined, u)
  }
})

Deno.test('accepts ordinary public URLs', () => {
  assertEquals(assertPublicUrl('https://abdash.net/').hostname, 'abdash.net')
  assertEquals(assertPublicUrl('http://example.com:80/a?b=c').protocol, 'http:')
  assertEquals(assertPublicUrl('https://example.com:443/x').port, '')
  assertEquals(assertPublicUrl('  https://example.com/  ').hostname, 'example.com')
  assertEquals(assertPublicUrl('https://8.8.8.8/').hostname, '8.8.8.8')
  assertEquals(assertPublicUrl('https://[2606:4700::1111]/').hostname, '[2606:4700::1111]')
})

Deno.test('does not confuse ordinary hostnames for reserved IPv6 prefixes', () => {
  // A naive `host.startsWith('fc')` check blocks fcbarcelona.com. Reserved-range
  // rules must only apply to things that are actually IP literals.
  for (
    const h of [
      'fcbarcelona.com',
      'fdic.gov',
      'fe80.example.com',
      'localhosting.com',
      'notlocalhost.dev',
      'internal-affairs.com',
      'metadata.google.com',
    ]
  ) {
    assertEquals(isBlockedAddress(h), false, h)
    assertEquals(assertPublicUrl(`https://${h}/`).hostname, h)
  }
})

// ---------------------------------------------------------------------------
// Raw address classification
// ---------------------------------------------------------------------------

Deno.test('classifies raw addresses correctly', () => {
  const blocked = [
    // IPv4 reserved space
    '127.0.0.1',
    '127.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.20.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1', //          carrier-grade NAT (RFC 6598)
    '100.127.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    // Obfuscated IPv4
    '0x7f000001',
    '2130706433',
    '0177.0.0.1',
    '127.0.1',
    // IPv6 reserved space
    '::1',
    '::',
    '[::1]',
    'fd00::1',
    'fc00::1',
    'fe80::1',
    'fe80::abcd:1234',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8', //      v4-mapped is refused wholesale; nothing legitimate uses it
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1', //         deprecated IPv4-compatible form
    '64:ff9b::7f00:1', //     NAT64 well-known prefix
    '2002:7f00:1::1', //      6to4, embeds an IPv4 address
    '2001:0:1234::1', //      Teredo, embeds an IPv4 address
  ]
  for (const ip of blocked) assertEquals(isBlockedAddress(ip), true, ip)

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '99.83.190.102',
    '172.32.0.1', //          just outside 172.16.0.0/12
    '100.128.0.1', //         just outside 100.64.0.0/10
    '11.0.0.1',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '2606:4700::1111',
    '2a00:1450:4001:80f::200e',
    '[2606:4700::1111]',
  ]
  for (const ip of allowed) assertEquals(isBlockedAddress(ip), false, ip)
})

Deno.test('treats malformed address-ish strings as non-addresses, not as public', () => {
  // These are not IP literals; they fall through to hostname handling, which is
  // where the DNS resolution check catches anything dangerous.
  for (const s of ['999.999.999.999', '1.2.3.4.5', '', '::gggg', '1:2:3:4:5:6:7:8:9']) {
    assertEquals(isBlockedAddress(s), false, JSON.stringify(s))
  }
})

// ---------------------------------------------------------------------------
// Resolved-address validation (the DNS half of the guard)
// ---------------------------------------------------------------------------

Deno.test('assertResolvedAddresses rejects when any resolved address is private', () => {
  assertThrows(
    () => assertResolvedAddresses('evil.example', ['93.184.216.34', '127.0.0.1']),
    SsrfError,
  )
  assertThrows(
    () => assertResolvedAddresses('evil.example', ['169.254.169.254']),
    SsrfError,
  )
  assertThrows(
    () => assertResolvedAddresses('evil.example', ['::ffff:127.0.0.1']),
    SsrfError,
  )
})

Deno.test('assertResolvedAddresses rejects a host that resolves to nothing', () => {
  assertThrows(() => assertResolvedAddresses('nx.example', []), SsrfError)
})

Deno.test('assertResolvedAddresses accepts an all-public answer', () => {
  assertResolvedAddresses('example.com', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
})

// ---------------------------------------------------------------------------
// guardedFetch: redirects, rebinding, content type, size cap
// ---------------------------------------------------------------------------

interface Harness {
  deps: GuardedFetchDeps
  requested: string[]
  resolved: string[]
}

/**
 * Builds an injectable fetch/resolve pair so the redirect and rebinding paths
 * can be exercised deterministically. `handler` returns the response for each
 * request; `resolver` returns the addresses for each hostname lookup, in call
 * order, so a host can legitimately "change" its address mid-chain.
 */
function harness(
  handler: (url: URL, hop: number) => Response,
  resolver: (host: string, call: number) => string[] = () => ['93.184.216.34'],
): Harness {
  const requested: string[] = []
  const resolved: string[] = []
  let hop = 0
  let call = 0
  return {
    requested,
    resolved,
    deps: {
      fetch: (input: string | URL | Request) => {
        const href = input instanceof Request ? input.url : String(input)
        requested.push(href)
        return Promise.resolve(handler(new URL(href), hop++))
      },
      resolve: (host: string) => {
        resolved.push(host)
        return Promise.resolve(resolver(host, call++))
      },
    },
  }
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  })
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

Deno.test('guardedFetch returns the body of a plain public page', async () => {
  const h = harness(() => html('<html><body>hi</body></html>'))
  const res = await guardedFetchWith(h.deps, 'https://example.com/')
  assertEquals(res.status, 200)
  assertEquals(res.body, '<html><body>hi</body></html>')
  assertEquals(res.redirects, [])
  assertEquals(res.url, 'https://example.com/')
  assertEquals(h.requested.length, 1)
})

Deno.test('guardedFetch never issues a request for a blocked URL', async () => {
  const h = harness(() => html('should not happen'))
  await assertRejects(
    () => guardedFetchWith(h.deps, 'http://169.254.169.254/latest/meta-data/'),
    SsrfError,
  )
  assertEquals(h.requested, [])
  assertEquals(h.resolved, [])
})

Deno.test('guardedFetch revalidates every redirect hop', async () => {
  const h = harness((url) =>
    url.pathname === '/' ? redirectTo('http://169.254.169.254/') : html('metadata!')
  )
  const err = (await assertRejects(
    () => guardedFetchWith(h.deps, 'https://example.com/'),
    SsrfError,
  )) as Error
  assertStringIncludes(err.message, 'private or reserved')
  // The first hop was allowed; the redirect target must never have been fetched.
  assertEquals(h.requested, ['https://example.com/'])
})

Deno.test('guardedFetch refuses a redirect to a non-http scheme', async () => {
  const h = harness((url) =>
    url.pathname === '/' ? redirectTo('file:///etc/passwd') : html('nope')
  )
  await assertRejects(() => guardedFetchWith(h.deps, 'https://example.com/'), SsrfError)
  assertEquals(h.requested, ['https://example.com/'])
})

Deno.test('guardedFetch refuses a redirect to a non-standard port', async () => {
  const h = harness((url) =>
    url.pathname === '/' ? redirectTo('http://example.com:11211/') : html('nope')
  )
  await assertRejects(() => guardedFetchWith(h.deps, 'https://example.com/'), SsrfError)
  assertEquals(h.requested, ['https://example.com/'])
})

Deno.test('guardedFetch resolves relative redirect targets against the current URL', async () => {
  const h = harness((url) => url.pathname === '/a' ? redirectTo('/b') : html('landed'))
  const res = await guardedFetchWith(h.deps, 'https://example.com/a')
  assertEquals(res.body, 'landed')
  assertEquals(res.url, 'https://example.com/b')
  assertEquals(res.redirects, ['https://example.com/b'])
})

Deno.test('guardedFetch follows at most MAX_REDIRECTS hops', async () => {
  assertEquals(MAX_REDIRECTS, 3)

  // Exactly 3 redirects then a page: allowed.
  const ok = harness((url) => {
    const n = Number(url.pathname.slice(1))
    return n < 3 ? redirectTo(`/${n + 1}`) : html('final')
  })
  const res = await guardedFetchWith(ok.deps, 'https://example.com/0')
  assertEquals(res.body, 'final')
  assertEquals(res.redirects.length, 3)
  assertEquals(ok.requested.length, 4)

  // A fourth redirect: refused, and the fifth request is never made.
  const tooMany = harness((url) => {
    const n = Number(url.pathname.slice(1))
    return redirectTo(`/${n + 1}`)
  })
  const err = (await assertRejects(
    () => guardedFetchWith(tooMany.deps, 'https://example.com/0'),
    SsrfError,
  )) as Error
  assertStringIncludes(err.message, 'redirect')
  assertEquals(tooMany.requested.length, MAX_REDIRECTS + 1)
})

Deno.test('guardedFetch refuses a redirect without a Location header', async () => {
  const h = harness(() => new Response(null, { status: 301 }))
  await assertRejects(() => guardedFetchWith(h.deps, 'https://example.com/'), SsrfError)
})

Deno.test('guardedFetch re-resolves DNS before every request (rebinding)', async () => {
  // The host resolves public on the first lookup and private on the second.
  // A guard that resolves once and then follows the redirect on trust would
  // hand the second request to 127.0.0.1.
  const h = harness(
    (url) => url.pathname === '/' ? redirectTo('https://rebind.example/inner') : html('pwned'),
    (_host, call) => (call === 0 ? ['93.184.216.34'] : ['127.0.0.1']),
  )
  const err = (await assertRejects(
    () => guardedFetchWith(h.deps, 'https://rebind.example/'),
    SsrfError,
  )) as Error
  assertStringIncludes(err.message, 'resolves')
  assertEquals(h.requested, ['https://rebind.example/'])
  assertEquals(h.resolved.length, 2)
})

Deno.test('guardedFetch refuses a host that resolves to a private address up front', async () => {
  const h = harness(() => html('should not happen'), () => ['10.0.0.7'])
  await assertRejects(() => guardedFetchWith(h.deps, 'https://sneaky.example/'), SsrfError)
  assertEquals(h.requested, [])
})

Deno.test('guardedFetch skips DNS for a public IP literal but still checks it', async () => {
  const h = harness(() => html('<p>ok</p>'))
  const res = await guardedFetchWith(h.deps, 'https://93.184.216.34/')
  assertEquals(res.status, 200)
  assertEquals(h.resolved, []) // nothing to resolve; the literal was checked directly
})

Deno.test('guardedFetch rejects a non-HTML content type by default', async () => {
  const h = harness(() =>
    new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })
  )
  const err = (await assertRejects(
    () => guardedFetchWith(h.deps, 'https://example.com/x.pdf'),
    UnsupportedContentError,
  )) as Error
  assertStringIncludes(err.message, 'application/pdf')
  // A PDF is not an attack. Reporting it as one would tell the submitter their
  // URL was refused for safety, which is both wrong and unactionable.
  assertEquals(err instanceof SsrfError, false)
  assertEquals((err as UnsupportedContentError).status, 415)
})

Deno.test('a redirect chain that ends at a non-HTML document says so, and does not say "refusing"', async () => {
  const h = harness((url) =>
    url.pathname === '/report'
      ? redirectTo('https://example.com/report.pdf')
      : new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })
  )
  const err = (await assertRejects(
    () => guardedFetchWith(h.deps, 'https://example.com/report'),
    UnsupportedContentError,
  )) as Error
  assertStringIncludes(err.message, 'Critiq reviews web pages')
  assertEquals(err.message.includes('Refusing'), false)
})

Deno.test('guardedFetch accepts other content types when asked to', async () => {
  const h = harness(() =>
    new Response('User-agent: *\nDisallow:', { headers: { 'content-type': 'text/plain' } })
  )
  const res = await guardedFetchWith(h.deps, 'https://example.com/robots.txt', {
    contentTypes: 'any',
  })
  assertStringIncludes(res.body, 'User-agent')
})

Deno.test('guardedFetch truncates at maxBytes instead of buffering the whole body', async () => {
  const big = 'x'.repeat(50_000)
  const h = harness(() => html(big))
  const res = await guardedFetchWith(h.deps, 'https://example.com/', { maxBytes: 1024 })
  assertEquals(res.body.length, 1024)
  assertEquals(res.truncated, true)
})

Deno.test('guardedFetch records timing and the final URL', async () => {
  const h = harness((url) => url.pathname === '/' ? redirectTo('/final') : html('done'))
  const res = await guardedFetchWith(h.deps, 'https://example.com/')
  assertEquals(res.url, 'https://example.com/final')
  assertEquals(typeof res.elapsedMs, 'number')
  assertEquals(res.elapsedMs >= 0, true)
})

// ---------------------------------------------------------------------------
// End-to-end: the real fetch path must refuse a real local server
// ---------------------------------------------------------------------------

Deno.test('the real guardedFetch will not touch a live loopback server', async () => {
  let hits = 0
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    () => {
      hits++
      return new Response('<html>secret</html>', {
        headers: { 'content-type': 'text/html' },
      })
    },
  )
  try {
    const { port } = server.addr as Deno.NetAddr
    const { guardedFetch } = await import('./ssrf.ts')
    await assertRejects(() => guardedFetch(`http://127.0.0.1:${port}/`), SsrfError)
    await assertRejects(() => guardedFetch(`http://localhost:${port}/`), SsrfError)
    assertEquals(hits, 0)
  } finally {
    await server.shutdown()
  }
})
