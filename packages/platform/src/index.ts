// The single public surface of @labs/platform.
// Apps import from '@labs/platform' only — never from a deep path.

export { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './client'
export { requireEnv } from './env'

export type { Session } from './session'
export {
  useSession, ensureAnonymousSession,
  linkGitHub, linkGoogle, sendMagicLink, signOut,
} from './session'

export { AuthGate } from './AuthGate'
export { TurnstileWidget } from './Turnstile'

export { quotaFor, usedToday, QuotaExceededError } from './quota'
