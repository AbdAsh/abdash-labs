import { linkGitHub } from '@labs/platform'
import { describeError, type RawError } from '../lib/errors'

/**
 * A failure the reader can do something about.
 *
 * Three parts, always: what happened in plain words, why — because "that
 * address cannot be reviewed from here" is infuriating without the reason — and
 * the single action that resolves it. The server's own message is kept
 * underneath rather than replaced, so nothing is hidden behind the paraphrase.
 */
export function ErrorPanel(
  { error, onRetry }: { error: RawError; onRetry?: () => void },
) {
  const described = describeError(error)
  const showRaw = described.raw !== '' && described.raw !== described.detail

  return (
    <div className="failure" role="alert">
      <h2 className="failure__title">{described.title}</h2>
      <p className="failure__detail">{described.detail}</p>

      {described.action === 'link-github' && (
        <button type="button" className="button" onClick={() => void linkGitHub()}>
          Link a GitHub account
        </button>
      )}

      {described.action === 'retry' && onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      )}

      {showRaw && (
        <details className="failure__raw">
          <summary>What the server said</summary>
          <pre>{described.raw}</pre>
        </details>
      )}
    </div>
  )
}
