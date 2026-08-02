import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export interface Caller { userId: string; isAnonymous: boolean; jwt: string }

class AuthError extends Error { status = 401 }

/** Extracts and verifies the caller's JWT. Every function starts with this. */
export async function getCaller(req: Request): Promise<Caller> {
  const header = req.headers.get('Authorization') ?? ''
  const jwt = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!jwt) throw new AuthError('Missing Authorization header')

  const { data, error } = await callerClient(jwt).auth.getUser(jwt)
  if (error || !data.user) throw new AuthError('Invalid session')

  return {
    userId: data.user.id,
    isAnonymous: data.user.is_anonymous === true,
    jwt,
  }
}

/** A client bound to the caller's JWT, so every query runs under their RLS
 *  policies. This is the only client app functions may use for user data. */
export function callerClient(jwt: string): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } },
  )
}

/** RLS-BYPASSING client. Legitimate in exactly two places, both of which have no
 *  caller to act as: `platform-health` (cron target) and `concierge-turn`'s per-IP
 *  rate limiter (unauthenticated site visitors). Anywhere else is a bug — quota
 *  enforcement does not need this, because `consume_quota` is SECURITY DEFINER
 *  and is called through the caller's own client. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}
