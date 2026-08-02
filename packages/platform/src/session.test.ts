import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted, not bare consts: vi.mock is hoisted above these declarations, and
// its factory runs on first import of './session' — reading plain consts there
// hits the temporal dead zone.
const { signInAnonymously, getSession, onAuthStateChange } = vi.hoisted(() => ({
  signInAnonymously: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}))

vi.mock('./client', () => ({
  supabase: { auth: { signInAnonymously, getSession, onAuthStateChange } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'anon',
}))

import { ensureAnonymousSession, toSession } from './session'

describe('toSession', () => {
  it('maps a supabase user to the platform Session shape', () => {
    expect(toSession({ id: 'u1', is_anonymous: true, email: null } as never))
      .toEqual({ userId: 'u1', isAnonymous: true, email: null })
  })

  it('treats a missing is_anonymous flag as a linked account', () => {
    expect(toSession({ id: 'u2', email: 'a@b.c' } as never).isAnonymous).toBe(false)
  })
})

describe('ensureAnonymousSession', () => {
  beforeEach(() => { signInAnonymously.mockReset(); getSession.mockReset() })

  it('reuses an existing session without signing in again', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'u1', is_anonymous: true } } } })
    const s = await ensureAnonymousSession('tok')
    expect(s.userId).toBe('u1')
    expect(signInAnonymously).not.toHaveBeenCalled()
  })

  it('passes the captcha token when creating a new session', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    signInAnonymously.mockResolvedValue({
      data: { user: { id: 'u2', is_anonymous: true } }, error: null,
    })
    await ensureAnonymousSession('captcha-abc')
    expect(signInAnonymously).toHaveBeenCalledWith({ options: { captchaToken: 'captcha-abc' } })
  })

  it('throws when sign-in fails', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    signInAnonymously.mockResolvedValue({ data: { user: null }, error: new Error('nope') })
    await expect(ensureAnonymousSession('tok')).rejects.toThrow('nope')
  })
})
