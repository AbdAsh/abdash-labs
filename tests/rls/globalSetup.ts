import { createClient } from '@supabase/supabase-js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const POOL_FILE = 'node_modules/.cache/rls-pool.json'

export interface PooledSession {
  userId: string
  accessToken: string
  refreshToken: string
}

/**
 * Signs the shared identity pool in ONCE for the entire run.
 *
 * A module-level pool inside `helpers.ts` is not enough: Vitest gives each test
 * file its own module registry, so a pool of three built there is rebuilt five
 * times — fifteen sign-ins, not three. Against Supabase's IP-based limit on
 * anonymous sign-ups that is still over budget, and the symptom is the nastiest
 * kind: the suite fails *differently* on each run depending on how much of the
 * hourly allowance is left, so failures look like RLS defects and are not.
 *
 * globalSetup runs once per invocation, before any file, which is the only scope
 * that actually matches "one pool per run". Sessions are handed to the files
 * through a cache file rather than `process.env`, because globalSetup runs in a
 * separate process and env does not propagate back reliably.
 */
export default async function setup() {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  if (!url || !anon) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to run RLS tests')
  }

  const sessions: PooledSession[] = []
  // Serially, not in parallel: a burst of simultaneous sign-ups is precisely the
  // shape the rate limiter is watching for.
  for (let i = 0; i < 3; i++) {
    const db = createClient(url, anon, { auth: { persistSession: false } })
    const { data, error } = await db.auth.signInAnonymously()
    if (error) {
      throw new Error(
        `Anonymous sign-in ${i + 1}/3 failed: ${error.message}. ` +
          'If this says "rate limit", the hourly budget is spent — wait for the window ' +
          'rather than raising the limit, which is a real abuse control. If it says ' +
          '"disabled", enable anonymous sign-ins under Authentication → Sign In / Providers.',
      )
    }
    sessions.push({
      userId: data.user!.id,
      accessToken: data.session!.access_token,
      refreshToken: data.session!.refresh_token,
    })
  }

  mkdirSync(dirname(POOL_FILE), { recursive: true })
  writeFileSync(POOL_FILE, JSON.stringify(sessions), 'utf8')
  // eslint-disable-next-line no-console
  console.log(`\n  rls: signed in ${sessions.length} pooled identities for this run\n`)
}
