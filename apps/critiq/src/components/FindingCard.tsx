import { useState } from 'react'
import { SOURCE_LABELS } from '../lib/format'
import type { Finding } from '../lib/types'

export function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article className={`finding finding--${finding.severity}`}>
      <header className="finding__head">
        <span className={`pill pill--${finding.severity}`}>{finding.severity}</span>
        {/* Labelling the source is the honesty of the whole tool: the reader can
            see what was measured and what was judged. */}
        <span className={`pill pill--${finding.source}`}>{SOURCE_LABELS[finding.source]}</span>
        <h3 className="finding__title">{finding.title}</h3>
      </header>

      {finding.evidence && (
        <div className="finding__block">
          <span className="finding__label">Evidence</span>
          <pre className="finding__evidence">{finding.evidence}</pre>
        </div>
      )}

      {finding.fix && (
        <div className="finding__block">
          <span className="finding__label">Fix</span>
          <p className="finding__fix">{finding.fix}</p>
        </div>
      )}

      {finding.code && <CopyableCode code={finding.code} />}

      <footer className="finding__foot">
        <code className="finding__id">{finding.id}</code>
      </footer>
    </article>
  )
}

function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="finding__block">
      <div className="finding__codehead">
        <span className="finding__label">Suggested markup</span>
        <button type="button" className="button button--ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="finding__code">{code}</pre>
    </div>
  )
}
