import { SOURCE_LABELS } from '../lib/format'
import { evidenceAddsSomething } from '../lib/evidence'
import { findingToMarkdown } from '../lib/markdown'
import { CopyButton } from './CopyButton'
import { Evidence } from './Evidence'
import type { Finding } from '../lib/types'

export function FindingCard({ finding }: { finding: Finding }) {
  const showEvidence = evidenceAddsSomething(finding.evidence, finding.title)

  return (
    <article className={`finding finding--${finding.severity}`}>
      <header className="finding__head">
        <span className={`pill pill--${finding.severity}`}>{finding.severity}</span>
        {/* Labelling the source is the honesty of the whole tool: the reader can
            see what was measured and what was judged. */}
        <span className={`pill pill--${finding.source}`}>{SOURCE_LABELS[finding.source]}</span>
        <h3 className="finding__title">{finding.title}</h3>
      </header>

      {showEvidence && (
        <div className="finding__block">
          <span className="finding__label">Evidence</span>
          <Evidence evidence={finding.evidence} />
        </div>
      )}

      {finding.fix && (
        <div className="finding__block">
          <span className="finding__label">Fix</span>
          <p className="finding__fix">{finding.fix}</p>
        </div>
      )}

      {finding.code && (
        <div className="finding__block">
          <div className="finding__codehead">
            <span className="finding__label">Suggested markup</span>
            <CopyButton text={finding.code} label="Copy markup" />
          </div>
          <pre className="finding__code">{finding.code}</pre>
        </div>
      )}

      <footer className="finding__foot">
        <code className="finding__id">{finding.id}</code>
        {/* The report is where you read the problem; it is almost never where
            you fix it. This is the finding as markdown, ready for a ticket. */}
        <CopyButton text={findingToMarkdown(finding)} label="Copy finding" />
      </footer>
    </article>
  )
}
