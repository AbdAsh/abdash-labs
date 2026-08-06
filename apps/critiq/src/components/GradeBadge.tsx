import { gradeTone } from '../lib/format'

/**
 * A grade. When `onClick` is supplied it becomes the dimension filter, which is
 * the interaction the grid was always implying: a reader who sees D next to
 * "Crawlability" wants those findings, and nothing else.
 */
export function GradeBadge({
  grade,
  label,
  large = false,
  count,
  active = false,
  onClick,
}: {
  grade: string | undefined
  label?: string
  large?: boolean
  count?: number
  active?: boolean
  onClick?: () => void
}) {
  const tone = gradeTone(grade)
  const className = `grade grade--${tone}${large ? ' grade--large' : ''}${
    active ? ' is-active' : ''
  }`

  const body = (
    <>
      <span className="grade__letter">{grade ?? '?'}</span>
      {label && (
        <span className="grade__label">
          {label}
          {count !== undefined && (
            <span className="grade__count">
              {count === 0 ? 'nothing to fix' : `${count} finding${count === 1 ? '' : 's'}`}
            </span>
          )}
        </span>
      )}
    </>
  )

  if (!onClick) return <div className={className}>{body}</div>

  return (
    <button
      type="button"
      className={`${className} grade--button`}
      aria-pressed={active}
      onClick={onClick}
    >
      {body}
    </button>
  )
}
