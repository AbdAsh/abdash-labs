import { useCallback, useEffect, useRef, useState } from 'react'
import { detectCapability, type Capability } from './lib/hardware'
import { generate, loadModel, stop, warmUp } from './lib/engine'
import { DEFAULT_TIER_ID, tierById, type ModelTier, type TierId } from './lib/tiers'
import { listConversations, saveConversation, type Conversation } from './lib/history'
import { DownloadProgress } from './components/DownloadProgress'
import { FirstRun } from './components/FirstRun'
import { OfflineBadge } from './components/OfflineBadge'
import { StoragePanel } from './components/StoragePanel'
import { Unsupported } from './components/Unsupported'

/**
 * PlaneMode.
 *
 * There is deliberately no auth anywhere in this tree. The shared session
 * exists on this origin, but an app whose entire thesis is "no server is
 * involved" must never read it or prompt for it — so nothing here imports
 * @labs/platform, and the root is not wrapped in AuthGate.
 */

type Phase = 'detecting' | 'first-run' | 'downloading' | 'ready'

interface Turn {
  role: string
  content: string
}

const CONVERSATION_ID = 'default'

export default function App() {
  const [capability, setCapability] = useState<Capability | null>(null)
  const [phase, setPhase] = useState<Phase>('detecting')
  const [tier, setTier] = useState<ModelTier | null>(null)
  const [progress, setProgress] = useState({ fraction: 0, phase: 'Starting…' })
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [trimmed, setTrimmed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void detectCapability().then((detected) => {
      setCapability(detected)
      setPhase(detected.webgpu ? 'first-run' : 'detecting')
    })
  }, [])

  useEffect(() => {
    void listConversations().then((saved: Conversation[]) => {
      const existing = saved.find((c) => c.id === CONVERSATION_ID)
      if (existing) setTurns(existing.messages)
    })
  }, [])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [turns])

  const start = useCallback(async (id: TierId) => {
    const chosen = tierById(id)
    setTier(chosen)
    setPhase('downloading')
    setError(null)

    await loadModel(chosen, (event) => {
      if (event.type === 'download') {
        setProgress({ fraction: event.loaded / (event.total || 1), phase: event.text })
      } else if (event.type === 'error') {
        setError(event.message)
      }
    })

    setPhase('ready')
    // A throwaway generation, so the first real message does not also pay the
    // one-off shader-compilation cost.
    setProgress({ fraction: 1, phase: 'Warming up…' })
    await warmUp()
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || streaming) return

    const next = [...turns, { role: 'user', content: text }]
    setTurns([...next, { role: 'assistant', content: '' }])
    setDraft('')
    setStreaming(true)
    setError(null)

    let reply = ''
    await generate(next, (event) => {
      if (event.type === 'token') {
        reply += event.text
        setTurns([...next, { role: 'assistant', content: reply }])
      } else if (event.type === 'trimmed') {
        setTrimmed(event.dropped)
      } else if (event.type === 'error') {
        setError(event.message)
      }
    })

    setStreaming(false)
    const finished = [...next, { role: 'assistant', content: reply }]
    setTurns(finished)
    await saveConversation({
      id: CONVERSATION_ID,
      title: finished[0]?.content.slice(0, 60) ?? 'Conversation',
      messages: finished,
      updatedAt: Date.now(),
    })
  }, [draft, streaming, turns])

  if (!capability) return <main className="booting">Checking what this device can do…</main>
  if (!capability.webgpu) return <Unsupported capability={capability} />
  if (phase === 'first-run') return <FirstRun capability={capability} onStart={start} />
  if (phase === 'downloading' && tier) {
    return <DownloadProgress tier={tier} fraction={progress.fraction} phase={progress.phase} />
  }

  return (
    <main className="app">
      <header className="app__bar">
        <h1>PlaneMode</h1>
        <OfflineBadge />
      </header>

      {error && <p className="app__error">{error}</p>}
      {trimmed > 0 && (
        <p className="app__notice">
          Earlier messages were trimmed — {trimmed} older{' '}
          {trimmed === 1 ? 'turn no longer fits' : 'turns no longer fit'} in the model's{' '}
          {(tier ?? tierById(DEFAULT_TIER_ID)).contextWindow}-token context window.
        </p>
      )}

      <div className="app__transcript" ref={transcriptRef}>
        {turns.length === 0 && (
          <p className="app__empty">
            Ask it something. Then turn your network off and ask it something else.
          </p>
        )}
        {turns.map((turn, index) => (
          <article key={index} className={`turn turn--${turn.role}`}>
            <p>{turn.content}</p>
          </article>
        ))}
      </div>

      <form
        className="app__composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message — this stays on your device"
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {streaming ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>

      <p className="app__disclaimer">
        Small local model — quick and private, not authoritative. Verify anything important.
      </p>

      <StoragePanel tier={tier} />
    </main>
  )
}
