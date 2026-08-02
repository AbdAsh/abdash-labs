import { supabase } from './client'

export class QuotaExceededError extends Error {
  constructor(app: string, key: string) {
    super(`Daily limit reached for ${app}:${key}. Sign in to raise your limit.`)
    this.name = 'QuotaExceededError'
  }
}

/** Everything quota-related lives in the `platform` Postgres schema. The shared
 *  client is deliberately left on `public` so each app can chain its own
 *  `.schema('recto')` etc., which means these calls must select the schema
 *  themselves — without it PostgREST looks in `public` and returns PGRST202. */
const platform = () => supabase.schema('platform')

/** The caller's limit for a resource cap. Returns 0 on any failure or when the
 *  key is unconfigured, so a broken lookup denies rather than permits. */
export async function quotaFor(app: string, key: string): Promise<number> {
  const { data, error } = await platform().rpc('quota_for', { p_app: app, p_key: key })
  if (error || typeof data !== 'number' || data < 0) return 0
  return data
}

/** Today's consumption, for progress display. Absent row means nothing used yet.
 *  No `user_id` filter is needed — RLS scopes `usage_counters` to `auth.uid()`. */
export async function usedToday(app: string, key: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await platform()
    .from('usage_counters')
    .select('count')
    .eq('app', app).eq('key', key).eq('window_start', today)
    .maybeSingle()
  return data?.count ?? 0
}
