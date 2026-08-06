import { useSyncExternalStore } from 'react'
import { offlineTracker, type OfflineState } from '../lib/offline'

/**
 * The airplane test, turned into UI.
 *
 * "Offline verified" only appears once a generation has actually finished, with
 * tokens, while the network was down for the whole of it. Until then the badge
 * reports the connection and nothing more, because claiming verification off
 * `navigator.onLine` alone would be a claim the app has not earned. The rules
 * live in ../lib/offline.ts, which imports nothing from React so they can be
 * tested without a DOM.
 */

const SERVER_SNAPSHOT: OfflineState = { offline: false, verified: false }

function useOfflineVerified(): OfflineState {
  return useSyncExternalStore(
    offlineTracker.subscribe,
    offlineTracker.getSnapshot,
    () => SERVER_SNAPSHOT,
  )
}

export function OfflineBadge() {
  const { offline, verified } = useOfflineVerified()

  const state = verified ? 'verified' : offline ? 'offline' : 'online'
  const label =
    state === 'verified'
      ? 'Offline verified'
      : state === 'offline'
        ? 'Offline — not yet verified'
        : 'Online'
  const title =
    state === 'verified'
      ? 'A reply was generated on this device, start to finish, with no network connection.'
      : state === 'offline'
        ? 'No connection. Send a message to prove the model still answers.'
        : 'Connected. Turn the network off and send a message to verify.'

  return (
    <span className={`badge badge--${state}`} title={title} aria-live="polite">
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  )
}
