/**
 * The two things this app has to ask the browser for before it downloads a
 * gigabyte: durability, and exclusivity.
 *
 * Both are asked for on the main thread and both fail soft — an old browser
 * that supports neither still works, it is just less protected.
 */

export type PersistResult = 'persisted' | 'denied' | 'unsupported'

/**
 * Without persistent storage the browser treats the cached weights as
 * best-effort data and may evict them under pressure. The user would then open
 * the app on a plane and find a gigabyte-scale download waiting — the entire
 * premise, silently broken. It has to be asked for *before* the download
 * starts.
 *
 * `StorageManager.persist()` is `[Exposed=Window]`: it does not exist on
 * `WorkerNavigator`, so this must run on the main thread, not inside the engine
 * worker.
 */
export async function requestPersistentStorage(): Promise<PersistResult> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
  if (typeof storage?.persist !== 'function') return 'unsupported'
  try {
    // Already-granted origins short-circuit without re-prompting.
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'persisted'
    return (await storage.persist()) ? 'persisted' : 'denied'
  } catch {
    return 'unsupported'
  }
}

export const ENGINE_LOCK_NAME = 'planemode-engine'

interface LockManagerLike {
  request: (
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>
}

function currentLocks(): LockManagerLike | undefined {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks
  return typeof locks?.request === 'function' ? locks : undefined
}

/**
 * Claims the right to be the tab that holds the model.
 *
 * Two tabs of PlaneMode each try to put two or three gigabytes of weights into
 * VRAM, and the second one takes the GPU down with an allocation failure that
 * looks, from the outside, like the app being broken. Web Locks are the cheapest
 * honest answer: the first tab wins, the second is told plainly what happened.
 *
 * The lock is deliberately never released — the callback returns a promise that
 * never settles, so the browser holds it for the lifetime of the page and drops
 * it the moment the tab closes. Returns `true` when the browser has no Web Locks
 * at all, because refusing to run is worse than an unenforced guarantee.
 */
export function acquireEngineLock(): Promise<boolean> {
  const locks = currentLocks()
  if (!locks) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (held: boolean) => {
      if (settled) return
      settled = true
      resolve(held)
    }

    try {
      void Promise.resolve(
        locks.request(ENGINE_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (!lock) {
            settle(false)
            return Promise.resolve()
          }
          settle(true)
          // Held until the page goes away.
          return new Promise<never>(() => {})
        }),
      ).catch(() => settle(true))
    } catch {
      settle(true)
    }
  })
}
