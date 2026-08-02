import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  registerServiceWorker,
  SW_SCOPE,
  SW_URL,
  isScopedToPlaneMode,
  NAVIGATE_FALLBACK_DENYLIST,
} from './sw-register'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('registerServiceWorker', () => {
  it('registers with the /planemode/ scope, never the origin root', async () => {
    const register = vi.fn().mockResolvedValue({ scope: 'https://x/planemode/' })
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    await registerServiceWorker()

    expect(register).toHaveBeenCalledWith(
      expect.stringContaining('/planemode/'),
      expect.objectContaining({ scope: '/planemode/' }),
    )
  })

  it('returns null when service workers are unavailable', async () => {
    vi.stubGlobal('navigator', {})
    await expect(registerServiceWorker()).resolves.toBeNull()
  })

  it('returns null when navigator itself is absent', async () => {
    vi.stubGlobal('navigator', undefined)
    await expect(registerServiceWorker()).resolves.toBeNull()
  })

  // Six sibling apps share this origin. A root-scoped worker would control all of
  // them, so the scope is asserted from both directions: it must be /planemode/,
  // and it must never be the origin root under any circumstance.
  it('never asks for a root scope or a root-relative script url', async () => {
    const register = vi.fn().mockResolvedValue({ scope: 'https://x/planemode/' })
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    await registerServiceWorker()

    const [url, options] = register.mock.calls[0] as [string, RegistrationOptions]
    expect(options.scope).toBe('/planemode/')
    expect(options.scope).not.toBe('/')
    expect(url.startsWith('/planemode/')).toBe(true)
    expect(url).not.toBe('/sw.js')
  })

  it('exports constants that are path-qualified, not origin-root', () => {
    expect(SW_SCOPE).toBe('/planemode/')
    expect(SW_URL).toBe('/planemode/sw.js')
  })

  it('unregisters and returns null if the browser resolves a wider scope than /planemode/', async () => {
    const unregister = vi.fn().mockResolvedValue(true)
    // A misconfigured Service-Worker-Allowed header could widen the scope to the
    // origin root. If that ever happens the worker is torn down immediately
    // rather than left controlling the sibling apps.
    const register = vi.fn().mockResolvedValue({ scope: 'https://x/', unregister })
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    await expect(registerServiceWorker()).resolves.toBeNull()
    expect(unregister).toHaveBeenCalled()
  })

  it('returns the registration when the resolved scope is /planemode/', async () => {
    const registration = { scope: 'https://labs.abdash.net/planemode/', unregister: vi.fn() }
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue(registration) } })

    await expect(registerServiceWorker()).resolves.toBe(registration)
    expect(registration.unregister).not.toHaveBeenCalled()
  })

  it('returns null instead of throwing when registration rejects', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { register: vi.fn().mockRejectedValue(new Error('insecure context')) },
    })
    await expect(registerServiceWorker()).resolves.toBeNull()
  })
})

// The regex vite.config.ts hands to Workbox as navigateFallbackDenylist. A
// match means the worker declines to serve the navigation fallback for that
// path, so every sibling app's path MUST match and PlaneMode's must not.
describe('NAVIGATE_FALLBACK_DENYLIST', () => {
  const denied = (path: string) => NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(path))

  it.each(['/', '/recto/', '/asksheet/', '/graphread/', '/raglab/', '/critiq/', '/index.html'])(
    'denies the fallback for the sibling path %s',
    (path) => {
      expect(denied(path)).toBe(true)
    },
  )

  it.each(['/planemode/', '/planemode/index.html', '/planemode/chat/42'])(
    'allows the fallback for %s',
    (path) => {
      expect(denied(path)).toBe(false)
    },
  )

  it('is not fooled by a prefix that merely starts with planemode', () => {
    expect(denied('/planemode-evil/')).toBe(true)
  })
})

describe('isScopedToPlaneMode', () => {
  it.each([
    ['https://labs.abdash.net/planemode/', true],
    ['/planemode/', true],
    ['https://labs.abdash.net/', false],
    ['https://labs.abdash.net/recto/', false],
    ['https://labs.abdash.net/planemode-evil/', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (scope, expected) => {
    expect(isScopedToPlaneMode(scope as string | undefined)).toBe(expected)
  })
})
