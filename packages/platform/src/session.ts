import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from './client'

export interface Session {
  userId: string
  isAnonymous: boolean
  email: string | null
}

export function toSession(user: User): Session {
  return {
    userId: user.id,
    // Absent flag means a real identity; only anonymous users carry it as true.
    isAnonymous: user.is_anonymous === true,
    email: user.email ?? null,
  }
}

/** Returns the current session, creating an anonymous one if none exists.
 *  The captcha token is required by Supabase when Turnstile protection is on. */
export async function ensureAnonymousSession(captchaToken?: string): Promise<Session> {
  const { data } = await supabase.auth.getSession()
  if (data.session?.user) return toSession(data.session.user)

  // Omit `options` entirely when there is no token. Passing
  // `{ captchaToken: undefined }` is not the same thing to every client
  // version, and Supabase rejects a token-less sign-in anyway when its own
  // captcha protection is enabled — which is the loud failure we want over a
  // silent one.
  const { data: created, error } = await supabase.auth.signInAnonymously(
    captchaToken ? { options: { captchaToken } } : undefined,
  )
  if (error) throw error
  return toSession(created.user!)
}

export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session?.user ? toSession(data.session.user) : null)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s?.user ? toSession(s.user) : null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  return { session, loading }
}

const redirectTo = () => `${window.location.origin}${window.location.pathname}`

/** Upgrades the current anonymous user in place — the notebooks they already
 *  created stay theirs, because the user id does not change. */
export async function linkGitHub(): Promise<void> {
  const { error } = await supabase.auth.linkIdentity({
    provider: 'github', options: { redirectTo: redirectTo() },
  })
  if (error) throw error
}

export async function linkGoogle(): Promise<void> {
  const { error } = await supabase.auth.linkIdentity({
    provider: 'google', options: { redirectTo: redirectTo() },
  })
  if (error) throw error
}

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email, options: { emailRedirectTo: redirectTo() },
  })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}
