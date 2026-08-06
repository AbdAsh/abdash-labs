import { classifyEvidence, tokenizeMarkup } from '../lib/evidence'

/**
 * Renders evidence as what it actually is.
 *
 * Markup is tokenised and coloured so the tag and the attribute value stand
 * apart from the noise; measured chains and JSON keep monospace without the
 * pretend syntax highlighting; a sentence about a measurement is rendered as a
 * sentence, because setting prose in a code box makes it harder to read for no
 * gain.
 *
 * Every token goes through React as a text node. Evidence is quoted from a page
 * a stranger asked us to fetch, so it is untrusted by construction and there is
 * no `dangerouslySetInnerHTML` anywhere in this file by design.
 */
export function Evidence({ evidence }: { evidence: string }) {
  const runs = classifyEvidence(evidence)
  if (runs.length === 0) return null

  return (
    <div className="evidence">
      {runs.map((run, index) => {
        if (run.kind === 'text') {
          return (
            <p className="evidence__text" key={index}>
              {run.lines.join(' ')}
            </p>
          )
        }
        if (run.kind === 'code') {
          return (
            <pre className="evidence__code" key={index}>{run.lines.join('\n')}</pre>
          )
        }
        return (
          <pre className="evidence__markup" key={index}>
            <code>
              {run.lines.map((line, lineIndex) => (
                <span className="evidence__line" key={lineIndex}>
                  {tokenizeMarkup(line).map((token, tokenIndex) => (
                    <span className={`tok tok--${token.type}`} key={tokenIndex}>{token.text}</span>
                  ))}
                  {lineIndex < run.lines.length - 1 ? '\n' : ''}
                </span>
              ))}
            </code>
          </pre>
        )
      })}
    </div>
  )
}
