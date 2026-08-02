import { useState } from 'react'

/**
 * Every answer shows its work.
 *
 * Collapsed by default so it does not shout, copyable so it is actually useful,
 * and always present — including on the answers that went wrong. A copilot that
 * hides its query is asking to be trusted; one that shows it can be checked.
 */
export function SqlDisclosure({
  sql,
  label = 'SQL',
  defaultOpen = false,
  onDownload,
}: {
  sql: string
  label?: string
  defaultOpen?: boolean
  onDownload?: () => void
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <details className="sql" open={defaultOpen}>
      <summary>{label}</summary>
      <pre>
        <code>{sql}</code>
      </pre>
      <div className="sql-actions">
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy SQL'}
        </button>
        {onDownload && (
          <button type="button" className="btn" onClick={onDownload}>
            Download result as CSV
          </button>
        )}
      </div>
    </details>
  )
}
