import { useSyncExternalStore } from 'react'
import { offlineTracker, type OfflineState } from '../lib/offline'

const SERVER_SNAPSHOT: OfflineState = { offline: false, verified: false }

/**
 * React binding for the offline tracker.
 *
 * Deliberately thin. All the logic — and all the tests — live in
 * ../lib/offline.ts, which imports nothing from React so it can be exercised
 * without a DOM or a renderer.
 */
export function useOfflineVerified(): OfflineState {
  return useSyncExternalStore(
    offlineTracker.subscribe,
    offlineTracker.getSnapshot,
    () => SERVER_SNAPSHOT,
  )
}
