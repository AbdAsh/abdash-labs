import { coverageLabel, passedChecks } from '../lib/checks'

/**
 * What the deterministic engine verified and cleared.
 *
 * Without this a clean report is a blank page with an A on it, which reads as a
 * tool that failed rather than a page that passed. It is also the only place
 * the reader can see the *denominator* — how much was actually examined — which
 * is the difference between "nothing is wrong" and "nothing was looked at".
 *
 * Prominent when there is nothing else on the page, folded away when there is.
 */
export function PassedChecks(
  { passed, failedCount }: { passed: readonly string[]; failedCount: number },
) {
  const checks = passedChecks(passed)
  if (checks.length === 0) return null

  const summary = coverageLabel(passed, failedCount)
  const list = (
    <ul className="passed">
      {checks.map((check) => (
        <li className="passed__item" key={check.id}>
          <span className="passed__tick" aria-hidden="true">✓</span>
          <span>{check.passed}</span>
          <code className="passed__id">{check.id}</code>
        </li>
      ))}
    </ul>
  )

  if (failedCount === 0) {
    return (
      <div className="verified">
        <h2 className="subtitle">{summary}</h2>
        {list}
      </div>
    )
  }

  return (
    <details className="verified verified--folded">
      <summary className="verified__summary">{summary}</summary>
      {list}
    </details>
  )
}
