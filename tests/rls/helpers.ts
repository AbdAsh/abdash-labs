import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL!
const ANON = process.env.SUPABASE_ANON_KEY!

/** Signs in a fresh anonymous user and returns its client and id.
 *  Two of these are two genuinely different tenants — the basis of every RLS test.
 *
 *  The client is left on the default (`public`) schema so each app's tests can
 *  chain `.schema('recto')`, `.schema('platform')`, and so on. Do not pin a
 *  schema here — every app shares this helper. */
export async function anonUser(): Promise<{ db: SupabaseClient; userId: string }> {
  if (!URL || !ANON) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to run RLS tests')
  }
  const db = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await db.auth.signInAnonymously()
  if (error) throw error
  return { db, userId: data.user!.id }
}
