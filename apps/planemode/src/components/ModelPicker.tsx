import { TIERS, formatBytes, type TierId } from '../lib/tiers'

/** Model choice, with the download size stated on every option. */
export function ModelPicker({
  value,
  recommended,
  disabled,
  onChange,
}: {
  value: TierId
  recommended: TierId | null
  disabled?: boolean
  onChange: (id: TierId) => void
}) {
  return (
    <fieldset className="picker" disabled={disabled}>
      <legend>Choose a model</legend>
      {TIERS.map((tier) => (
        <label key={tier.id} className={`picker__option${value === tier.id ? ' is-selected' : ''}`}>
          <input
            type="radio"
            name="tier"
            value={tier.id}
            checked={value === tier.id}
            onChange={() => onChange(tier.id)}
          />
          <span className="picker__label">
            {tier.label}
            {recommended === tier.id && <span className="picker__flag">Recommended here</span>}
          </span>
          <span className="picker__size">{formatBytes(tier.approxBytes)} to download</span>
          <span className="picker__blurb">{tier.blurb}</span>
          <code className="picker__id">{tier.modelId}</code>
        </label>
      ))}
    </fieldset>
  )
}
