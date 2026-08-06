import { describe, it, expect, vi, afterEach } from 'vitest'
import { ENGINE_LOCK_NAME, acquireEngineLock, requestPersistentStorage } from './persist'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestPersistentStorage', () => {
  it('reports unsupported rather than throwing when the API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(requestPersistentStorage()).resolves.toBe('unsupported')
  })

  it('does not re-prompt an origin that is already persisted', async () => {
    const persist = vi.fn()
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } })

    await expect(requestPersistentStorage()).resolves.toBe('persisted')
    expect(persist).not.toHaveBeenCalled()
  })

  it('asks, and reports a refusal honestly', async () => {
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => false } })
    await expect(requestPersistentStorage()).resolves.toBe('denied')
  })

  it('survives a storage API that throws', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => {
          throw new Error('SecurityError')
        },
        persist: async () => true,
      },
    })
    await expect(requestPersistentStorage()).resolves.toBe('unsupported')
  })
})

/** A Web Locks stand-in with one lock name and one holder at a time. */
function stubLocks() {
  const held = new Set<string>()
  const request = vi.fn(
    async (
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<unknown>,
    ) => {
      if (held.has(name) && options.ifAvailable) return callback(null)
      held.add(name)
      return callback({ name })
    },
  )
  vi.stubGlobal('navigator', { locks: { request } })
  return { request, held }
}

describe('acquireEngineLock', () => {
  it('is granted to the first tab', async () => {
    stubLocks()
    await expect(acquireEngineLock()).resolves.toBe(true)
  })

  // Two tabs each pushing a multi-gigabyte model into VRAM is an allocation
  // failure that looks like the app being broken. The second tab has to be told.
  it('is refused to a second tab while the first still holds it', async () => {
    stubLocks()

    await expect(acquireEngineLock()).resolves.toBe(true)
    await expect(acquireEngineLock()).resolves.toBe(false)
  })

  it('resolves without waiting for the lock to be released', async () => {
    stubLocks()
    // The holding callback never settles by design; if the implementation
    // awaited it, this test would time out rather than pass.
    await expect(acquireEngineLock()).resolves.toBe(true)
  })

  it('asks for an exclusive lock that does not queue', async () => {
    const { request } = stubLocks()

    await acquireEngineLock()

    expect(request).toHaveBeenCalledWith(
      ENGINE_LOCK_NAME,
      expect.objectContaining({ mode: 'exclusive', ifAvailable: true }),
      expect.any(Function),
    )
  })

  // An unenforced guarantee beats refusing to run at all.
  it('assumes exclusivity when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    await expect(acquireEngineLock()).resolves.toBe(true)
  })

  it('assumes exclusivity when the lock request rejects', async () => {
    vi.stubGlobal('navigator', { locks: { request: vi.fn().mockRejectedValue(new Error('nope')) } })
    await expect(acquireEngineLock()).resolves.toBe(true)
  })

  it('assumes exclusivity when the lock request throws synchronously', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(() => {
          throw new Error('nope')
        }),
      },
    })
    await expect(acquireEngineLock()).resolves.toBe(true)
  })
})
