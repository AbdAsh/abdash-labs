import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ensureAnonymousSession, useSession } from './session'
import { TurnstileWidget } from './Turnstile'

/** Whether a Turnstile site key is configured for this build. */
function hasTurnstile(): boolean {
  const key = import.meta.env.VITE_TURNSTILE_SITE_KEY
  return typeof key === 'string' && key.trim() !== ''
}

/**
 * Guarantees a session before children mount. A first-time visitor gets an
 * anonymous account; returning visitors see nothing.
 *
 * The captcha is conditional, and it has to be. `TurnstileWidget` returns early
 * when no site key is configured, so it renders nothing and never fires its
 * callback — and because the callback was the only path to
 * `ensureAnonymousSession`, an unconfigured build sat on "Setting up your
 * workspace…" forever. Not a hypothetical: the site key is a build-time
 * variable, so any deploy that forgets it, and every local `npm run dev`,
 * bricked every app's live mode while the saved examples kept working and
 * masked it.
 *
 * So: with a key, solve the challenge and pass the token. Without one, sign in
 * directly. That is only safe because the two settings belong together —
 * Supabase rejects a token-less anonymous sign-in when its own captcha
 * protection is on, so a half-configured deploy fails loudly at the auth call
 * with a message that names the cause, instead of hanging on a spinner that
 * names nothing.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const attempted = useRef(false)

  const start = useCallback(async (token?: string) => {
    if (attempted.current) return
    attempted.current = true
    setStarting(true)
    try {
      await ensureAnonymousSession(token)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Let the visitor retry rather than stranding them on a dead screen.
      attempted.current = false
    } finally {
      setStarting(false)
    }
  }, [])

  // No captcha configured: nothing is going to hand us a token, so go straight
  // to the sign-in rather than waiting for a widget that will never render.
  useEffect(() => {
    if (loading || session || hasTurnstile()) return
    void start()
  }, [loading, session, start])

  useEffect(() => { setError(null) }, [session])

  if (loading) return <div className="auth-gate" aria-busy="true">Loading…</div>
  if (session) return <>{children}</>

  return (
    <div className="auth-gate">
      <p>Setting up your workspace…</p>
      {hasTurnstile() && !starting && <TurnstileWidget onToken={start} />}
      {error && (
        <p className="error" role="alert">
          Could not start a session: {error}
        </p>
      )}
    </div>
  )
}
