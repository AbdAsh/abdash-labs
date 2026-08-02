/**
 * Per-IP rate limiting for unauthenticated surfaces.
 *
 * The concierge is the only unauthenticated surface in the program: a visitor to
 * abdash.net has no Supabase session, because that lives on the labs.abdash.net
 * origin. There is no caller JWT to act as and no user to charge a quota to, so
 * abuse control has to key on the network address instead.
 *
 * The visitor's IP is never stored. It is salted and hashed, and only the digest
 * becomes the bucket key, so the table cannot be read as a log of who visited.
 */

/** Buckets live in `platform.rate_limits (bucket, window_start, count)`. */
const TABLE = 'rate_limits'
const SCHEMA = 'platform'

export class RateLimitError extends Error {
  readonly status = 429
  constructor(public readonly retryAfterSec: number) {
    super(
      'Too many questions from this address in the last hour. ' +
        'Try again shortly, or email Abdulrahman directly.',
    )
    this.name = 'RateLimitError'
  }
}

/**
 * One increment against one bucket, returning the resulting count.
 *
 * Extracted as an interface so the limiting policy can be tested without a
 * database, and so nothing but the concrete implementation ever touches a
 * service-role client.
 */
export interface RateLimitStore {
  increment(bucket: string, windowStart: string): Promise<number>
}

export interface CheckOptions {
  store?: RateLimitStore
  /** Injectable clock, so window rollover is testable. */
  now?: () => number
}

/* ── identity ───────────────────────────────────────────────────────────── */

/**
 * The visitor's address, taken as the first entry of `x-forwarded-for`.
 *
 * The first entry is the original client; everything after it is the proxy
 * chain. Supabase's edge sits in front of this function, so the header is
 * always present in production.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? ''
  const first = forwarded.split(',')[0]?.trim()
  return first || 'unknown'
}

/**
 * Salted SHA-256 of an address, truncated to 128 bits.
 *
 * The salt is not optional. An unsalted SHA-256 of an IPv4 address is
 * reversible by brute force in seconds — the whole space is 2^32 — so storing
 * one would be storing the IP with extra steps. Missing salt is a
 * misconfiguration that must stop the function, not degrade it silently.
 */
export async function hashIp(ip: string): Promise<string> {
  const salt = Deno.env.get('CONCIERGE_IP_SALT')
  if (!salt) {
    throw new Error(
      'Missing required environment variable: CONCIERGE_IP_SALT ' +
        '(required so visitor addresses are not recoverable from bucket keys)',
    )
  }
  const bytes = new TextEncoder().encode(`${salt}:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

/** The bucket key for a request: `<prefix>:<hashed ip>`. */
export async function bucketFor(req: Request, prefix: string): Promise<string> {
  return `${prefix}:${await hashIp(clientIp(req))}`
}

/** Start of the fixed window containing `nowMs`, floored to `windowSec`. */
export function windowStart(windowSec: number, nowMs: number = Date.now()): Date {
  const ms = windowSec * 1000
  return new Date(Math.floor(nowMs / ms) * ms)
}

/* ── policy ─────────────────────────────────────────────────────────────── */

/**
 * Consumes one unit from a bucket, throwing `RateLimitError` (429) once the
 * window's allowance is spent.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
  options: CheckOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now
  const store = options.store ?? supabaseRateLimitStore()

  const start = windowStart(windowSec, now())
  const count = await store.increment(bucket, start.toISOString())

  if (count > limit) {
    const resetAt = start.getTime() + windowSec * 1000
    throw new RateLimitError(Math.max(1, Math.ceil((resetAt - now()) / 1000)))
  }
}

/* ── storage ────────────────────────────────────────────────────────────── */

/**
 * The real store, backed by `platform.rate_limits`.
 *
 * `serviceClient()` is imported dynamically rather than at module load. That
 * keeps an RLS-bypassing, service-role-capable client out of the import graph
 * of anything that only wants the pure helpers above — and it means these
 * helpers stay importable and testable without service-role credentials in the
 * environment.
 */
export function supabaseRateLimitStore(): RateLimitStore {
  return {
    async increment(bucket: string, windowStartIso: string): Promise<number> {
      const { serviceClient } = await import('./auth.ts')
      const db = serviceClient()
      const table = () => db.schema(SCHEMA).from(TABLE)

      // Common case: first request of the window.
      const inserted = await table().insert({
        bucket,
        window_start: windowStartIso,
        count: 1,
      })
      if (!inserted.error) return 1
      // 23505 is unique_violation — the row already exists, so fall through.
      if (inserted.error.code !== '23505') throw inserted.error

      // `platform.rate_limits` has no SECURITY DEFINER increment function and
      // this project adds no migration, so compare-and-set through PostgREST is
      // the strongest primitive available. The update is conditional on the
      // count we read, and a lost race just means another attempt.
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await table()
          .select('count')
          .eq('bucket', bucket)
          .eq('window_start', windowStartIso)
          .maybeSingle()
        if (current.error) throw current.error

        const seen = (current.data?.count as number | undefined) ?? 0
        const next = seen + 1

        const updated = await table()
          .update({ count: next })
          .eq('bucket', bucket)
          .eq('window_start', windowStartIso)
          .eq('count', seen)
          .select('count')
        if (updated.error) throw updated.error
        if (updated.data?.length === 1) return next
      }

      // Contention we could not settle. Fail closed: report the bucket as spent
      // rather than let an unbounded number of turns through.
      return Number.MAX_SAFE_INTEGER
    },
  }
}
