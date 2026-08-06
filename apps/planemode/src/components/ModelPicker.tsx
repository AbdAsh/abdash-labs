import { fitsInFreeSpace, type SpaceVerdict } from '../lib/hardware'
import { TIERS, formatBytes, type TierId } from '../lib/tiers'

/**
 * Model choice, with the download size — and whether it will actually fit —
 * stated on every option before anything is committed to.
 */
export function ModelPicker({
  value,
  recommended,
  cached,
  freeBytes,
  disabled,
  onChange,
}: {
  value: TierId
  recommended: TierId | null
  /** Tiers already fully on disk. Nothing to download, nothing to warn about. */
  cached: TierId[]
  freeBytes: number | null
  disabled?: boolean
  onChange: (id: TierId) => void
}) {
  return (
    <fieldset className="picker" disabled={disabled}>
      <legend>Choose a model</legend>
      {TIERS.map((tier) => {
        const onDisk = cached.includes(tier.id)
        const verdict: SpaceVerdict = onDisk ? 'fits' : fitsInFreeSpace(tier.approxBytes, freeBytes)

        return (
          <label
            key={tier.id}
            className={`picker__option${value === tier.id ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              name="tier"
              value={tier.id}
              checked={value === tier.id}
              onChange={() => onChange(tier.id)}
            />
            <span className="picker__label">
              {tier.label}
              {onDisk ? (
                <span className="picker__flag picker__flag--cached">Already downloaded</span>
              ) : (
                recommended === tier.id && <span className="picker__flag">Recommended here</span>
              )}
            </span>

            <span className={`picker__size${verdict === 'too-small' ? ' picker__size--blocked' : ''}`}>
              {onDisk
                ? `${formatBytes(tier.approxBytes)} already on this device`
                : `${formatBytes(tier.approxBytes)} to download`}
            </span>

            <span className="picker__blurb">{tier.blurb}</span>

            {verdict === 'too-small' && (
              <span className="picker__warning">
                This browser says it has only {formatBytes(freeBytes ?? 0)} left for this site, so
                this download would run out of room before it finished.
              </span>
            )}
            {verdict === 'tight' && (
              <span className="picker__warning">
                This will very nearly fill the space this browser allows —{' '}
                {formatBytes(freeBytes ?? 0)} free. It may fail near the end.
              </span>
            )}

            <code className="picker__id">{tier.modelId}</code>
          </label>
        )
      })}
    </fieldset>
  )
}
