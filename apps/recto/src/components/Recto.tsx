import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Turn, type TurnData } from './Turn'
import type { ConversationSummary } from '../lib/conversations'

const CROSS_DOCUMENT_STARTERS = [
  'What do these documents disagree about?',
  'Summarise the key points across every document',
]

const SINGLE_DOCUMENT_STARTERS = [
  'What is this document arguing?',
  'List the claims this document makes with page numbers',
]

/** The recto: the conversation. */
export function Recto({
  loading,
  hasNotebook,
  notebookTitle,
  readyCount,
  unfinishedCount,
  conversations,
  conversationId,
  turns,
  busy,
  error,
  messagesLeft,
  onDismissError,
  onAsk,
  onSelectConversation,
  onDeleteConversation,
  exhibit,
}: {
  loading: boolean
  hasNotebook: boolean
  notebookTitle: string
  readyCount: number
  unfinishedCount: number
  conversations: ConversationSummary[]
  conversationId: string | undefined
  turns: TurnData[]
  busy: boolean
  error: string | null
  /** Null while the caller's tier is still unknown. */
  messagesLeft: number | null
  onDismissError: () => void
  onAsk: (question: string) => void
  onSelectConversation: (id: string | undefined) => void
  onDeleteConversation: (id: string) => void
  /** Present when this transcript is a saved run rather than a live exchange.
   *  It takes the composer's place — which is where a visitor's eye goes when
   *  they want to ask something, and therefore the one spot where "this already
   *  happened, on a date, without you" cannot be missed. */
  exhibit?: ReactNode
}) {
  const [input, setInput] = useState('')
  const tail = useRef<HTMLDivElement>(null)
  const frozen = exhibit !== undefined

  useEffect(() => {
    // A saved transcript opens where the reader would start, not where it
    // finished. Following the tail is for an answer arriving now; doing it to a
    // recording drops someone into the middle of a conversation they have not
    // read, and `scrollIntoView` walks every scrollable ancestor on its way —
    // including the document, which would carry the banner off the top of the
    // page.
    if (frozen) return
    tail.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, frozen])

  const outOfMessages = messagesLeft === 0
  const canAsk = readyCount > 0 && !outOfMessages
  const starters = readyCount > 1 ? CROSS_DOCUMENT_STARTERS : SINGLE_DOCUMENT_STARTERS

  function submit(question: string) {
    const q = question.trim()
    if (!q || busy || !canAsk) return
    setInput('')
    onAsk(q)
  }

  return (
    <div className="recto">
      <header className="recto__head">
        <div className="recto__title">
          <h2 dir="auto">{loading ? 'Opening…' : notebookTitle}</h2>
          <p className="recto__meta">
            {loading
              ? ' '
              : `${readyCount} ${readyCount === 1 ? 'document' : 'documents'}${
                  unfinishedCount > 0 ? ` · ${unfinishedCount} unfinished` : ''
                }`}
          </p>
        </div>

        {/* The picker appears only once there is something to pick between.
            An empty select next to a "New conversation" button was two controls
            for one thing that could not be done yet. */}
        {conversations.length > 0 && (
          <div className="recto__threads">
            <label className="visually-hidden" htmlFor="conversation">
              Conversation
            </label>
            <select
              id="conversation"
              value={conversationId ?? ''}
              disabled={frozen}
              onChange={(e) => onSelectConversation(e.target.value || undefined)}
            >
              {!frozen && <option value="">New conversation</option>}
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || 'Untitled'}
                </option>
              ))}
            </select>
            {!frozen && conversationId && (
              <button
                type="button"
                className="action action--quiet"
                onClick={() => onDeleteConversation(conversationId)}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </header>

      <div className="transcript">
        {turns.length === 0 && !loading && (
          <div className="opening">
            {!hasNotebook ? (
              <p className="opening__lead">
                Make a notebook on the facing page, add a document or two, and ask it anything.
                Every answer is drawn only from what is in the notebook, with the passages cited by
                document and page.
              </p>
            ) : readyCount === 0 && unfinishedCount > 0 ? (
              <p className="opening__lead">
                {unfinishedCount === 1 ? 'A document in this notebook' : 'The documents here'} did
                not finish indexing, so there is nothing to search yet. Remove{' '}
                {unfinishedCount === 1 ? 'it' : 'them'} on the facing page and add{' '}
                {unfinishedCount === 1 ? 'it' : 'them'} again.
              </p>
            ) : readyCount === 0 ? (
              <p className="opening__lead">
                Add a document on the facing page, then ask this notebook anything. Every answer is
                drawn only from what is in it, with the passages cited by document and page.
              </p>
            ) : (
              <>
                <p className="opening__lead">
                  {readyCount > 1
                    ? 'Ask across every document at once. Answers cite the passages they came from.'
                    : 'Ask this document anything. Answers cite the passages they came from.'}
                </p>
                <div className="starters">
                  {starters.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="starter"
                      onClick={() => submit(s)}
                      disabled={busy || !canAsk}
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
          <p className="notice" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="notice__dismiss"
              aria-label="Dismiss"
              onClick={onDismissError}
            >
              ×
            </button>
          </p>
        )}
        <div ref={tail} />
      </div>

      {/* Composer and allowance dock together, so the count stays with the
          field it constrains when the transcript scrolls past both. */}
      <div className="composer-dock">
        {frozen ? (
          exhibit
        ) : (
          <>
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
                placeholder={outOfMessages ? 'Daily limit reached' : 'Ask this notebook…'}
                disabled={busy || !canAsk}
                aria-label="Ask this notebook a question"
                dir="auto"
              />
              <button type="submit" disabled={busy || !input.trim() || !canAsk}>
                {busy ? 'Asking…' : 'Ask'}
              </button>
            </form>

            {/* The cap is worth seeing before it is hit, not only after. */}
            {messagesLeft !== null && (
              <p className="allowance" data-spent={outOfMessages || undefined}>
                {outOfMessages
                  ? 'No messages left today. Link GitHub or Google below to raise the limit.'
                  : `${messagesLeft} ${messagesLeft === 1 ? 'message' : 'messages'} left today.`}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
