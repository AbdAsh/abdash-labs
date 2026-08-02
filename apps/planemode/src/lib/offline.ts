/**
 * The offline-verified tracker — the demo's money moment turned into UI state.
 *
 * `offline` mirrors the connection. `verified` is a stronger claim: it only
 * becomes true once a generation has *completed* while the connection was down,
 * and stayed down for the whole of that generation. `navigator.onLine` on its
 * own is a claim about the network stack, not about whether this app can still
 * produce tokens, so the badge refuses to make the claim until it is earned.
 *
 * Framework-free on purpose. The React binding is a thin
 * `useSyncExternalStore` adapter in ../hooks/useOfflineVerified.ts, which keeps
 * this logic testable without a DOM or a renderer.
 */

export interface OfflineState {
  offline: boolean
  verified: boolean
}

export interface OfflineHost {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

interface PendingGeneration {
  startedOffline: boolean
  /** The reconnect count at the moment this generation started. */
  epoch: number
}

export class OfflineTracker {
  #offline: boolean
  #verified = false
  /** Increments every time the connection comes back. Comparing it across a
   *  generation is how we know the network never returned mid-flight. */
  #onlineEpoch = 0
  #pending: PendingGeneration | null = null
  #snapshot: OfflineState
  #listeners = new Set<() => void>()

  constructor({ initiallyOnline = true }: { initiallyOnline?: boolean } = {}) {
    this.#offline = !initiallyOnline
    this.#snapshot = { offline: this.#offline, verified: false }
  }

  /** Stable between changes, so useSyncExternalStore does not tear. */
  getSnapshot = (): OfflineState => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  setOnline(online: boolean): void {
    if (online) this.#onlineEpoch += 1
    const offline = !online
    if (offline === this.#offline) return
    this.#offline = offline
    this.#publish()
  }

  recordGenerationStarted(): void {
    this.#pending = { startedOffline: this.#offline, epoch: this.#onlineEpoch }
  }

  /**
   * The only thing that can flip `verified`, and only when the generation was
   * offline end to end: offline when it started, offline when it finished, with
   * no reconnect in between. A generation that was never announced falls back
   * to "offline right now", which is the strongest claim available.
   */
  recordGenerationComplete(): void {
    const pending = this.#pending
    this.#pending = null

    const offlineThroughout =
      pending === null || (pending.startedOffline && pending.epoch === this.#onlineEpoch)
    if (this.#verified || !this.#offline || !offlineThroughout) return

    this.#verified = true
    this.#publish()
  }

  recordGenerationFailed(): void {
    this.#pending = null
  }

  /** Wires `online`/`offline` events. Returns a detach function. */
  attach(host: OfflineHost): () => void {
    const goOnline = () => this.setOnline(true)
    const goOffline = () => this.setOnline(false)
    host.addEventListener('online', goOnline)
    host.addEventListener('offline', goOffline)
    return () => {
      host.removeEventListener('online', goOnline)
      host.removeEventListener('offline', goOffline)
    }
  }

  #publish(): void {
    this.#snapshot = { offline: this.#offline, verified: this.#verified }
    // Snapshot the set first: a listener is allowed to unsubscribe from inside
    // its own callback, which would otherwise mutate the set mid-iteration.
    const listeners = Array.from(this.#listeners)
    for (const listener of listeners) listener()
  }
}

function browserIsOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator
  return typeof nav?.onLine === 'boolean' ? nav.onLine : true
}

/** The app-wide tracker. Attaches itself in a browser; inert under Node. */
export const offlineTracker = new OfflineTracker({ initiallyOnline: browserIsOnline() })

const globalHost = globalThis as Partial<OfflineHost>
if (
  typeof globalHost.addEventListener === 'function' &&
  typeof globalHost.removeEventListener === 'function'
) {
  offlineTracker.attach(globalHost as OfflineHost)
}
