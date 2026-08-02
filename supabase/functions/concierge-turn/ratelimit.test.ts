/**
 * Tests for the per-IP rate limiter.
 *
 * These live under `concierge-turn/` rather than beside the module in
 * `_shared/` because the concierge is the only caller: it is the only
 * unauthenticated surface in the program, and the only place a per-IP bucket
 * makes sense. Everything else limits per user, through `consume_quota`.
 */
import {
  bucketFor,
  checkRateLimit,
  clientIp,
  hashIp,
  RateLimitError,
  type RateLimitStore,
  windowStart,
} from '../_shared/ratelimit.ts'

Deno.env.set('CONCIERGE_IP_SALT', 'test-salt')

/* Local assertions: this repo has no deno.json, so a `jsr:` import would be
   both a lint violation and a network dependency for running unit tests. */

function assert(condition: unknown, message = 'condition was not met'): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEquals<T>(actual: T, expected: T, message = ''): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Expected ${e}, got ${a}${message ? ` — ${message}` : ''}`)
}

async function assertRejects<E extends Error>(
  fn: () => Promise<unknown>,
  ErrorClass?: new (...args: never[]) => E,
  includes?: string,
): Promise<E> {
  try {
    await fn()
  } catch (e) {
    if (ErrorClass && !(e instanceof ErrorClass)) {
      throw new Error(`Expected ${ErrorClass.name}, got ${(e as Error)?.name}`)
    }
    if (includes && !String((e as Error)?.message).includes(includes)) {
      throw new Error(`Expected message containing "${includes}", got "${(e as Error)?.message}"`)
    }
    return e as E
  }
  throw new Error('Expected the call to reject, but it resolved')
}

/** In-memory stand-in for `platform.rate_limits`. */
function fakeStore(): RateLimitStore & { keys(): string[] } {
  const counts = new Map<string, number>()
  return {
    increment(bucket, windowStartIso) {
      const key = `${bucket}|${windowStartIso}`
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return Promise.resolve(next)
    },
    keys: () => [...counts.keys()],
  }
}

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/functions/v1/concierge-turn', {
    method: 'POST',
    headers,
  })
}

const HOUR = 3600

/* ── policy ─────────────────────────────────────────────────────────────── */

Deno.test('allows up to the limit within a window', async () => {
  const store = fakeStore()
  for (let i = 0; i < 20; i++) {
    await checkRateLimit('ip:abc', 20, HOUR, { store })
  }
})

Deno.test('throws on the request past the limit', async () => {
  const store = fakeStore()
  for (let i = 0; i < 20; i++) await checkRateLimit('ip:abc', 20, HOUR, { store })

  const error = await assertRejects(
    () => checkRateLimit('ip:abc', 20, HOUR, { store }),
    RateLimitError,
  )
  assertEquals(error.status, 429)
  assert(error.retryAfterSec > 0, 'should tell the caller when to come back')
  assert(error.retryAfterSec <= HOUR, 'retry-after cannot exceed the window')
})

Deno.test('resets in a new window', async () => {
  const store = fakeStore()
  const base = Date.parse('2026-08-01T10:30:00Z')
  let now = base
  const opts = { store, now: () => now }

  await checkRateLimit('ip:abc', 2, HOUR, opts)
  await checkRateLimit('ip:abc', 2, HOUR, opts)
  await assertRejects(() => checkRateLimit('ip:abc', 2, HOUR, opts), RateLimitError)

  // Same bucket, next hour: the allowance is fresh.
  now = base + HOUR * 1000
  await checkRateLimit('ip:abc', 2, HOUR, opts)
})

Deno.test('does not reset partway through a window', async () => {
  const store = fakeStore()
  const base = Date.parse('2026-08-01T10:00:00Z')
  let now = base
  const opts = { store, now: () => now }

  await checkRateLimit('ip:abc', 1, HOUR, opts)
  now = base + 59 * 60 * 1000 // 10:59 — still the 10:00 window
  await assertRejects(() => checkRateLimit('ip:abc', 1, HOUR, opts), RateLimitError)
})

Deno.test('buckets different IPs independently', async () => {
  const store = fakeStore()
  await checkRateLimit('ip:aaa', 1, HOUR, { store })
  await checkRateLimit('ip:bbb', 1, HOUR, { store })

  await assertRejects(() => checkRateLimit('ip:aaa', 1, HOUR, { store }), RateLimitError)
  await assertRejects(() => checkRateLimit('ip:bbb', 1, HOUR, { store }), RateLimitError)
})

/* ── windows ────────────────────────────────────────────────────────────── */

Deno.test('floors the window start to the window size', () => {
  const at = Date.parse('2026-08-01T10:47:31.482Z')
  assertEquals(windowStart(HOUR, at).toISOString(), '2026-08-01T10:00:00.000Z')
})

/* ── identity ───────────────────────────────────────────────────────────── */

Deno.test('takes the first entry of x-forwarded-for', () => {
  assertEquals(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' })), '203.0.113.7')
  assertEquals(clientIp(req({ 'x-forwarded-for': '  203.0.113.7  ' })), '203.0.113.7')
})

Deno.test('falls back to a constant when the header is absent', () => {
  assertEquals(clientIp(req({})), 'unknown')
  assertEquals(clientIp(req({ 'x-forwarded-for': '' })), 'unknown')
})

Deno.test('never puts a plaintext address in the bucket key', async () => {
  const ip = '203.0.113.7'
  const bucket = await bucketFor(req({ 'x-forwarded-for': `${ip}, 70.41.3.18` }), 'concierge')

  assert(!bucket.includes(ip), `bucket key leaked the visitor address: ${bucket}`)
  assert(bucket.startsWith('concierge:'), 'bucket should be namespaced by surface')
  assertEquals(bucket, `concierge:${await hashIp(ip)}`)
})

Deno.test('hashes the same address to the same bucket and different ones apart', async () => {
  assertEquals(await hashIp('203.0.113.7'), await hashIp('203.0.113.7'))
  assert((await hashIp('203.0.113.7')) !== (await hashIp('203.0.113.8')))
})

Deno.test('salts the hash, so the digest is not a bare hash of the address', async () => {
  const withSalt = await hashIp('203.0.113.7')
  Deno.env.set('CONCIERGE_IP_SALT', 'a-different-salt')
  const withOtherSalt = await hashIp('203.0.113.7')
  Deno.env.set('CONCIERGE_IP_SALT', 'test-salt')

  assert(withSalt !== withOtherSalt, 'changing the salt must change the digest')
})

Deno.test('refuses to hash without a salt, rather than storing a reversible digest', async () => {
  Deno.env.delete('CONCIERGE_IP_SALT')
  try {
    await assertRejects(() => hashIp('203.0.113.7'), Error, 'CONCIERGE_IP_SALT')
  } finally {
    Deno.env.set('CONCIERGE_IP_SALT', 'test-salt')
  }
})
