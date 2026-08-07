import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { POOL_FILE, type PooledSession } from './globalSetup'

const URL = process.env.SUPABASE_URL!
const ANON = process.env.SUPABASE_ANON_KEY!

export interface TestUser {
  db: SupabaseClient
  userId: string
}

/**
 * Supabase enforces an IP-based limit of 30 anonymous sign-ins per hour, and a
 * full pass of these suites called for 34 — so the harness could never go green,
 * and worse, it failed *differently* on each run depending on how much of the
 * hourly budget was left. The first run got 39 tests in before throttling; the
 * second started already exhausted and reported 19 failures that looked like RLS
 * defects and were not.
 *
 * The fix is to stop conflating "a different tenant" with "a new signup". Every
 * assertion here needs two identities that are not each other; almost none needs
 * an identity that has never existed before. So the pool is created once and
 * handed out round-robin: consecutive calls still return distinct users, which is
 * the property the tests actually rely on, while a whole run costs three sign-ins
 * instead of thirty-four.
 *
 * Three, not two, because a handful of tests take a third party as a bystander.
 */
let pool: TestUser[] | null = null
let cursor = 0

async function signIn(): Promise<TestUser> {
  const db = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await db.auth.signInAnonymously()
  if (error) {
    throw new Error(
      `Anonymous sign-in failed: ${error.message}. ` +
        'If this says "rate limit", the hourly budget is spent — wait for the window ' +
        'rather than raising the limit, which is a real abuse control.',
    )
  }
  return { db, userId: data.user!.id }
}

/**
 * Rehydrates the pool that `globalSetup.ts` signed in once for the whole run.
 *
 * Deliberately not signed in here. Vitest gives each test file its own module
 * registry, so a pool built in this module is rebuilt once per file — five
 * files, fifteen sign-ins — which is how a "pool of three" quietly became
 * seventeen and stayed over the rate limit.
 */
async function ensurePool(): Promise<TestUser[]> {
  if (pool) return pool
  if (!URL || !ANON) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to run RLS tests')
  }

  const raw = readFileSync(POOL_FILE, 'utf8')
  const sessions = JSON.parse(raw) as PooledSession[]

  pool = await Promise.all(
    sessions.map(async (s) => {
      const db = createClient(URL, ANON, { auth: { persistSession: false } })
      const { error } = await db.auth.setSession({
        access_token: s.accessToken,
        refresh_token: s.refreshToken,
      })
      if (error) throw error
      return { db, userId: s.userId }
    }),
  )
  return pool
}

/**
 * Returns a signed-in anonymous user, distinct from the one returned by the
 * previous call. Two calls in a row are two genuinely different tenants, which
 * is the basis of every isolation assertion here.
 *
 * Identities are reused across tests. Write with unique slugs and filter by id
 * so a leftover row from an earlier test cannot be mistaken for a leak — and
 * never assert on a bare row *count* for a pooled user, because it carries
 * whatever earlier tests left behind. Use `freshUser()` where a never-before-seen
 * account is genuinely the thing under test.
 *
 * The client is left on the default (`public`) schema so each app's tests can
 * chain `.schema('recto')`, `.schema('platform')`, and so on. Do not pin a schema
 * here — every app shares this helper.
 */
export async function anonUser(): Promise<TestUser> {
  const users = await ensurePool()
  const user = users[cursor % users.length]!
  cursor++
  return user
}

/**
 * A brand-new account, for the few assertions that are about signup itself —
 * the profile trigger firing, or a quota counter starting from zero. Costs one
 * of the hourly thirty, so reach for `anonUser()` unless newness is the point.
 */
export async function freshUser(): Promise<TestUser> {
  if (!URL || !ANON) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to run RLS tests')
  }
  return signIn()
}

/** A client with no session at all: the `anon` role rather than `authenticated`. */
export function signedOut(): SupabaseClient {
  return createClient(URL, ANON, { auth: { persistSession: false } })
}
