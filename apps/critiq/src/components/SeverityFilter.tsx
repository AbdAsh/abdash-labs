import { SEVERITIES } from '../lib/format'
import type { Severity } from '../lib/types'

export function SeverityFilter({
  counts,
  total,
  value,
  onChange,
}: {
  counts: Record<Severity, number>
  total: number
  value: Severity | 'all'
  onChange: (next: Severity | 'all') => void
}) {
  return (
    <div className="filter" role="group" aria-label="Filter findings by severity">
      <FilterButton
        active={value === 'all'}
        label="All"
        count={total}
        onClick={() => onChange('all')}
      />
      {SEVERITIES.map((severity) => (
        <FilterButton
          key={severity}
          active={value === severity}
          label={severity}
          count={counts[severity]}
          disabled={counts[severity] === 0}
          onClick={() => onChange(severity)}
        />
      ))}
    </div>
  )
}

function FilterButton({
  active,
  label,
  count,
  disabled = false,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`filter__button${active ? ' is-active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
      <span className="filter__count">{count}</span>
    </button>
  )
}
