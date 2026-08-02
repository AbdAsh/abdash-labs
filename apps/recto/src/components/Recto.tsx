import { useEffect, useRef, useState } from 'react'
import { Turn, type TurnData } from './Turn'
import type { ConversationSummary } from '../lib/conversations'

const STARTERS = [
  'What do these documents disagree about?',
  'Summarise the key points across every document',
]

/** The recto: the conversation. */
export function Recto({
  notebookTitle,
  documentCount,
  conversations,
  conversationId,
  turns,
  busy,
  error,
  onAsk,
  onSelectConversation,
  onNewConversation,
}: {
  notebookTitle: string
  documentCount: number
  conversations: ConversationSummary[]
  conversationId: string | undefined
  turns: TurnData[]
  busy: boolean
  error: string | null
  onAsk: (question: string) => void
  onSelectConversation: (id: string | undefined) => void
  onNewConversation: () => void
}) {
  const [input, setInput] = useState('')
  const tail = useRef<HTMLDivElement>(null)

  useEffect(() => {
    tail.current?.scrollIntoView({ block: 'end' })
  }, [turns.length])

  function submit(question: string) {
    const q = question.trim()
    if (!q || busy) return
    setInput('')
    onAsk(q)
  }

  return (
    <div className="recto">
      <header className="recto__head">
        <div className="recto__title">
          <h2 dir="auto">{notebookTitle}</h2>
          <p className="recto__meta">
            {documentCount} {documentCount === 1 ? 'document' : 'documents'}
          </p>
        </div>

        <div className="recto__threads">
          <label className="visually-hidden" htmlFor="conversation">
            Conversation
          </label>
          <select
            id="conversation"
            value={conversationId ?? ''}
            onChange={(e) => onSelectConversation(e.target.value || undefined)}
          >
            <option value="">New conversation</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || 'Untitled'}
              </option>
            ))}
          </select>
          <button type="button" className="action action--quiet" onClick={onNewConversation}>
            Start fresh
          </button>
        </div>
      </header>

      <div className="transcript">
        {turns.length === 0 && (
          <div className="opening">
            {documentCount === 0 ? (
              <p className="opening__lead">
                Add a document on the facing page, then ask this notebook anything. Every answer is
                drawn only from what is in it, with the passages cited by document and page.
              </p>
            ) : (
              <>
                <p className="opening__lead">
                  Ask across every document at once. Answers cite the passages they came from.
                </p>
                <div className="starters">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="starter"
                      onClick={() => submit(s)}
                      disabled={busy}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {turns.map((turn, i) => (
          <Turn key={i} turn={turn} streaming={busy && i === turns.length - 1} />
        ))}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div ref={tail} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask this notebook…"
          disabled={busy || documentCount === 0}
          aria-label="Ask this notebook a question"
          dir="auto"
        />
        <button type="submit" disabled={busy || !input.trim() || documentCount === 0}>
          Ask
        </button>
      </form>
    </div>
  )
}
