import { gradeTone } from '../lib/format'

export function GradeBadge(
  { grade, label, large = false }: { grade: string | undefined; label?: string; large?: boolean },
) {
  const tone = gradeTone(grade)
  return (
    <div className={`grade grade--${tone}${large ? ' grade--large' : ''}`}>
      <span className="grade__letter">{grade ?? '?'}</span>
      {label && <span className="grade__label">{label}</span>}
    </div>
  )
}
