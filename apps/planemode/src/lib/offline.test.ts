import { describe, it, expect, vi } from 'vitest'
import { OfflineTracker } from './offline'

describe('OfflineTracker', () => {
  it('starts online and unverified', () => {
    const t = new OfflineTracker({ initiallyOnline: true })
    expect(t.getSnapshot()).toEqual({ offline: false, verified: false })
  })

  it('reports offline as soon as the connection drops', () => {
    const t = new OfflineTracker({ initiallyOnline: true })
    t.setOnline(false)
    expect(t.getSnapshot().offline).toBe(true)
  })

  // The whole point of the badge. navigator.onLine alone is a claim about the
  // network stack; it says nothing about whether this app can actually produce
  // tokens. Only a completed generation proves the premise.
  /** The happy path, spelled out once so the other tests can vary one hurdle. */
  function generateOffline(t: OfflineTracker, tokens = 3): void {
    t.recordGenerationStarted()
    for (let i = 0; i < tokens; i += 1) t.recordToken()
    t.recordGenerationComplete()
  }

  it('stays unverified while offline until a generation actually completes', () => {
    const t = new OfflineTracker({ initiallyOnline: false })

    expect(t.getSnapshot()).toEqual({ offline: true, verified: false })

    t.recordGenerationStarted()
    t.recordToken()
    expect(t.getSnapshot().verified).toBe(false)

    t.recordGenerationComplete()
    expect(t.getSnapshot().verified).toBe(true)
  })

  it('does not verify on a generation that merely started offline and never finished', () => {
    const t = new OfflineTracker({ initiallyOnline: false })
    t.recordGenerationStarted()
    t.recordToken()
    t.recordGenerationFailed()
    expect(t.getSnapshot().verified).toBe(false)
  })

  it('does not verify on a generation completed while online', () => {
    const t = new OfflineTracker({ initiallyOnline: true })
    generateOffline(t)
    expect(t.getSnapshot().verified).toBe(false)
  })

  it('does not verify a generation that started online and merely finished offline', () => {
    const t = new OfflineTracker({ initiallyOnline: true })
    t.recordGenerationStarted()
    t.recordToken()
    t.setOnline(false) // the connection dropped part-way through
    t.recordGenerationComplete()
    expect(t.getSnapshot().verified).toBe(false)
  })

  it('does not verify when the connection flaps back up and down mid-generation', () => {
    const t = new OfflineTracker({ initiallyOnline: false })
    t.recordGenerationStarted()
    t.recordToken()
    t.setOnline(true)
    t.setOnline(false)
    t.recordGenerationComplete()
    expect(t.getSnapshot().verified).toBe(false)
  })

  it('does not verify when the connection returns mid-generation', () => {
    const t = new OfflineTracker({ initiallyOnline: false })
    t.recordGenerationStarted()
    t.recordToken()
    t.setOnline(true) // the network came back before the last token
    t.recordGenerationComplete()
    expect(t.getSnapshot().verified).toBe(false)
  })

  // Pressing stop before the first token still ends the generation cleanly, but
  // the badge claims "a reply was generated". Nothing was.
  it('does not verify a generation that finished without producing a token', () => {
    const t = new OfflineTracker({ initiallyOnline: false })

    t.recordGenerationStarted()
    t.recordGenerationComplete()

    expect(t.getSnapshot().verified).toBe(false)
  })

  // The badge is the whole demo, so a completion the tracker never saw the start
  // of — a duplicated or stray `done` — must not be able to earn it alone.
  it('does not verify a completion it was never told the start of', () => {
    const t = new OfflineTracker({ initiallyOnline: false })

    t.recordGenerationComplete()

    expect(t.getSnapshot().verified).toBe(false)
  })

  it('does not let a second completion re-use the first generation’s evidence', () => {
    const t = new OfflineTracker({ initiallyOnline: false })

    t.recordGenerationStarted()
    t.recordToken()
    t.setOnline(true) // disqualifies this generation
    t.setOnline(false)
    t.recordGenerationComplete()
    t.recordGenerationComplete() // a duplicate `done` for the same request

    expect(t.getSnapshot().verified).toBe(false)
  })

  it('stops counting tokens against a generation that already finished', () => {
    const t = new OfflineTracker({ initiallyOnline: false })

    t.recordGenerationStarted()
    t.recordGenerationComplete() // zero tokens, so unverified
    t.recordToken() // a late token from the finished request
    t.recordGenerationComplete()

    expect(t.getSnapshot().verified).toBe(false)
  })

  it('stays verified for the rest of the session once it has been earned', () => {
    const t = new OfflineTracker({ initiallyOnline: false })
    generateOffline(t)
    expect(t.getSnapshot().verified).toBe(true)

    t.setOnline(true)
    expect(t.getSnapshot()).toEqual({ offline: false, verified: true })

    t.setOnline(false)
    t.recordGenerationStarted()
    expect(t.getSnapshot()).toEqual({ offline: true, verified: true })
  })

  it('notifies subscribers on change and not on a no-op', () => {
    const t = new OfflineTracker({ initiallyOnline: true })
    const listener = vi.fn()
    const unsubscribe = t.subscribe(listener)

    t.setOnline(true) // no change
    expect(listener).not.toHaveBeenCalled()

    t.setOnline(false)
    expect(listener).toHaveBeenCalledTimes(1)

    generateOffline(t)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    t.setOnline(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  // useSyncExternalStore tears the render if getSnapshot returns a fresh object
  // every call, so identity has to be stable between changes.
  it('returns a stable snapshot reference until something actually changes', () => {
    const t = new OfflineTracker({ initiallyOnline: true })
    const first = t.getSnapshot()

    expect(t.getSnapshot()).toBe(first)

    t.setOnline(false)
    expect(t.getSnapshot()).not.toBe(first)
    expect(t.getSnapshot()).toBe(t.getSnapshot())
  })

  it('tracks online and offline events from a host it is attached to', () => {
    const handlers = new Map<string, (() => void)[]>()
    const host = {
      addEventListener: (type: string, fn: () => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), fn])
      },
      removeEventListener: (type: string, fn: () => void) => {
        handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== fn))
      },
    }

    const t = new OfflineTracker({ initiallyOnline: true })
    const detach = t.attach(host)

    handlers.get('offline')!.forEach((fn) => fn())
    expect(t.getSnapshot().offline).toBe(true)

    handlers.get('online')!.forEach((fn) => fn())
    expect(t.getSnapshot().offline).toBe(false)

    detach()
    expect(handlers.get('offline')).toHaveLength(0)
    expect(handlers.get('online')).toHaveLength(0)
  })
})
