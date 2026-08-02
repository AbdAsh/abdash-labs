import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ensureAnonymousSession, useSession } from './session'
import { TurnstileWidget } from './Turnstile'

/** Guarantees a session before children mount. A first-time visitor solves an
 *  invisible captcha and gets an anonymous account; returning visitors see nothing. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const start = useCallback(async (token: string) => {
    setStarting(true)
    try { await ensureAnonymousSession(token) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setStarting(false) }
  }, [])

  useEffect(() => { setError(null) }, [session])

  if (loading) return <div className="auth-gate" aria-busy="true">Loading…</div>
  if (session) return <>{children}</>

  return (
    <div className="auth-gate">
      <p>Setting up your workspace…</p>
      {!starting && <TurnstileWidget onToken={start} />}
      {error && <p className="error" role="alert">Could not start a session: {error}</p>}
    </div>
  )
}
