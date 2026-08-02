import { createClient } from '@supabase/supabase-js'
import { requireEnv } from './env'

export const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL', import.meta.env)
export const SUPABASE_ANON_KEY = requireEnv('VITE_SUPABASE_ANON_KEY', import.meta.env)

/** One client for the whole origin. Because every app is served from a path under
 *  labs.abdash.net, this session is shared across all seven — that is the SSO. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
