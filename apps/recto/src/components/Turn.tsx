import { useState, type ReactNode } from 'react'
import type { Citation } from '../lib/chat'
import { Citations } from './Citations'

export interface TurnData {
  question: string
  answer: string
  citations: Citation[]
}

const CITE_RE = /\[(\d+)\]/g

/**
 * Render the answer text, turning each in-range [n] into a clickable footnote
 * reference. Out-of-range markers stay as plain text.
 */
function renderAnswer(text: string, maxN: number, onCite: (n: number) => void): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(CITE_RE)) {
    const at = m.index ?? 0
    const n = Number(m[1])
    if (at > last) parts.push(text.slice(last, at))
    if (n >= 1 && n <= maxN) {
      parts.push(
        <button
          key={`ref-${key++}`}
          type="button"
          className="cite-ref"
          onClick={() => onCite(n)}
          aria-label={`Show source ${n}`}
        >
          [{n}]
        </button>,
      )
    } else {
      parts.push(m[0])
    }
    last = at + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function Turn({ turn, streaming }: { turn: TurnData; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState<number | null>(null)

  function jumpTo(n: number) {
    setOpen(true)
    setHighlight(n)
  }

  return (
    <article className="turn">
      {/* dir="auto" on the content, never on the chrome: a reply that mixes
          Arabic and English then lays out correctly per paragraph, whichever
          way round the spread itself is facing. */}
      <p className="question" dir="auto">
        {turn.question}
      </p>
      {turn.answer ? (
        <p className="answer" dir="auto">
          {renderAnswer(turn.answer, turn.citations.length, jumpTo)}
          {streaming && <span className="answer__cursor" aria-hidden="true" />}
        </p>
      ) : streaming ? (
        <p className="answer answer--pending">
          <span className="thinking">Reading the notebook…</span>
        </p>
      ) : (
        // An empty answer that is not streaming is a turn whose reply never
        // arrived — the connection dropped, or the model failed after
        // retrieval. Reusing the pending state here left reloaded transcripts
        // saying "Reading the notebook…" forever, for a read that ended days ago.
        <p className="answer answer--lost">
          <span className="thinking">
            No answer came back for this question. Ask it again.
          </span>
        </p>
      )}
      <Citations
        items={turn.citations}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        highlight={highlight}
      />
    </article>
  )
}
