import { useOfflineVerified } from '../hooks/useOfflineVerified'

/**
 * The airplane test, turned into UI.
 *
 * "Offline verified" is only shown once a generation has actually finished with
 * the network down. Until then the badge reports the connection and nothing
 * more, because claiming verification off `navigator.onLine` alone would be a
 * claim the app has not earned.
 */
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
      ? 'A reply was generated on this device with no network connection.'
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
