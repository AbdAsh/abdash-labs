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
  /** Tokens actually produced. A stop at token zero proves nothing. */
  tokens: number
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
    this.#pending = { startedOffline: this.#offline, epoch: this.#onlineEpoch, tokens: 0 }
  }

  /** Every token the model actually produced, counted against the generation
   *  that is currently in flight. */
  recordToken(): void {
    if (this.#pending) this.#pending.tokens += 1
  }

  /**
   * The only thing that can flip `verified`, and it has to clear every hurdle:
   * a generation this tracker was told about, which started offline, produced
   * at least one real token, saw no reconnect in flight, and was still offline
   * when it finished.
   *
   * There is no fallback branch on purpose. An earlier version treated a
   * completion it had never seen the start of as good enough, which meant a
   * stray or duplicated `done` could earn the badge on its own. The badge is
   * the whole demo; it does not get to be optimistic.
   */
  recordGenerationComplete(): void {
    const pending = this.#pending
    this.#pending = null

    if (this.#verified) return
    if (!pending) return
    if (!pending.startedOffline) return
    if (pending.epoch !== this.#onlineEpoch) return
    if (pending.tokens === 0) return
    if (!this.#offline) return

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
