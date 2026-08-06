import { useCallback, useEffect, useRef, useState } from 'react'
import { detectCapability, type Capability } from './lib/hardware'
import { generate, loadModel, probeCache, stop, unload, warmUp } from './lib/engine'
import { acquireEngineLock } from './lib/persist'
import {
  describeEngineError,
  isFatal,
  INITIAL_PROGRESS,
  type EngineFailure,
  type LoadProgress,
} from './lib/engine-protocol'
import { TIERS, forgetTier, rememberTier, rememberedTier, tierById, type ModelTier, type TierId } from './lib/tiers'
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

type Phase =
  | 'detecting'
  /** Another tab already holds the model; two copies would exhaust the GPU. */
  | 'blocked'
  | 'first-run'
  | 'loading'
  /** Weights are resident; the throwaway generation is running. */
  | 'warming'
  | 'ready'
  | 'failed'

interface Turn {
  role: string
  content: string
}

const CONVERSATION_ID = 'default'

export default function App() {
  const [capability, setCapability] = useState<Capability | null>(null)
  const [phase, setPhase] = useState<Phase>('detecting')
  const [tier, setTier] = useState<ModelTier | null>(null)
  const [cached, setCached] = useState<TierId[]>([])
  const [resuming, setResuming] = useState<TierId | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [progress, setProgress] = useState<LoadProgress>(INITIAL_PROGRESS)
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [trimmed, setTrimmed] = useState(0)
  const [error, setError] = useState<EngineFailure | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)

  const start = useCallback(async (id: TierId, alreadyOnDisk = false) => {
    const chosen = tierById(id)
    setTier(chosen)
    setFromCache(alreadyOnDisk)
    setFailure(null)
    setError(null)
    setProgress(INITIAL_PROGRESS)
    setPhase('loading')
    // Written before the first byte, not after the last: a tab closed at 60%
    // still leaves a trace, which is what turns the next visit's landing page
    // from "download 1.82 GB" into "carry on where you stopped".
    rememberTier(id)

    const loaded = await loadModel(chosen, setProgress)
    if (!loaded.ok) {
      setFailure(describeEngineError(loaded.message ?? ''))
      setPhase('failed')
      return
    }

    // The old code went straight to 'ready' here and awaited the warm-up
    // afterwards, which left the composer live while a generation was already
    // running — two overlapping requests into one engine.
    setPhase('warming')
    const warm = await warmUp()
    if (!warm.ok) {
      // A model that loads and then cannot produce a single token is not ready,
      // and dropping the visitor into a chat box that answers nothing is worse
      // than saying so.
      setFailure(describeEngineError(warm.message ?? ''))
      setPhase('failed')
      return
    }

    setCached((ids) => (ids.includes(id) ? ids : [...ids, id]))
    setResuming(null)
    setPhase('ready')
  }, [])

  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true

    void (async () => {
      const detected = await detectCapability().catch(
        (): Capability => ({
          webgpu: false,
          approxMemoryGB: null,
          freeBytes: null,
          recommended: null,
          reason: 'This browser would not answer when asked what it supports.',
        }),
      )
      setCapability(detected)
      if (!detected.webgpu) return

      // Two tabs each pushing gigabytes into VRAM is an allocation failure that
      // looks, from the outside, like the app simply being broken.
      if (!(await acquireEngineLock())) {
        setPhase('blocked')
        return
      }

      // Only a browser that has committed to a tier before gets probed. A true
      // first-time visitor should not pay for the worker chunk — and everything
      // it pulls in — before they have agreed to anything.
      const remembered = rememberedTier()
      if (!remembered) {
        setPhase('first-run')
        return
      }

      const onDisk = await probeCache(TIERS.map((t) => t.modelId))
      const ids = TIERS.filter((t) => onDisk.includes(t.modelId)).map((t) => t.id)
      setCached(ids)

      if (ids.includes(remembered)) {
        // The airplane test: reopen, and it is simply there.
        void start(remembered, true)
      } else {
        setResuming(remembered)
        setPhase('first-run')
      }
    })()
  }, [start])

  useEffect(() => {
    void listConversations()
      .then((saved: Conversation[]) => {
        const existing = saved.find((c) => c.id === CONVERSATION_ID)
        if (existing) setTurns(existing.messages)
      })
      .catch(() => {
        // No history is a degraded session, not a broken one. The save path
        // reports its own failures where they are actionable.
      })
  }, [])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [turns])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || streaming || phase !== 'ready') return

    const next = [...turns, { role: 'user', content: text }]
    setTurns([...next, { role: 'assistant', content: '' }])
    setDraft('')
    setStreaming(true)
    setError(null)
    // The notice describes *this* reply. Left standing from an earlier one it
    // becomes a permanent banner quoting a number that stopped being true.
    setTrimmed(0)

    let reply = ''
    const outcome = await generate(next, (event) => {
      if (event.type === 'token') {
        reply += event.text
        setTurns([...next, { role: 'assistant', content: reply }])
      } else if (event.type === 'trimmed') {
        setTrimmed(event.dropped)
      }
    })

    setStreaming(false)
    if (!outcome.ok) setError(describeEngineError(outcome.message ?? ''))

    // An empty assistant bubble is worse than none; drop it if nothing arrived.
    const finished = reply ? [...next, { role: 'assistant', content: reply }] : next
    setTurns(finished)

    try {
      await saveConversation({
        id: CONVERSATION_ID,
        title: finished[0]?.content.slice(0, 60) ?? 'Conversation',
        messages: finished,
        updatedAt: Date.now(),
      })
      setSaveFailed(false)
    } catch {
      // Out of quota, or IndexedDB refused. The reply is on screen either way;
      // the visitor just needs to know it will not survive a reload.
      setSaveFailed(true)
    }
  }, [draft, streaming, phase, turns])

  const reloadModel = useCallback(() => {
    const id = tier?.id
    if (!id) return
    unload()
    void start(id, cached.includes(id))
  }, [tier, cached, start])

  const handleModelDeleted = useCallback((alsoWipedConversations: boolean) => {
    unload()
    forgetTier()
    setCached([])
    setResuming(null)
    setTier(null)
    setFromCache(false)
    setFailure(null)
    setError(null)
    if (alsoWipedConversations) setTurns([])
    setPhase('first-run')
  }, [])

  if (!capability) return <main className="booting">Checking what this device can do…</main>
  if (!capability.webgpu) return <Unsupported capability={capability} />

  if (phase === 'blocked') {
    return (
      <main className="blocked">
        <h1>PlaneMode is open in another tab</h1>
        <p>
          The model takes gigabytes of graphics memory, and two copies of it will not fit. That tab
          has it; this one is standing down rather than crashing both.
        </p>
        <p className="firstrun__smallprint">
          Close the other tab, then reload this one. Nothing has been lost either way — the weights
          are on disk, not in this page.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload this tab
        </button>
      </main>
    )
  }

  if (phase === 'first-run') {
    return (
      <FirstRun capability={capability} cached={cached} resuming={resuming} onStart={start} />
    )
  }

  if (phase === 'failed' && tier) {
    return (
      <main className="failed">
        <h1>That did not finish</h1>
        <p className="app__error">{failure?.message}</p>
        {failure?.kind === 'network' && (
          <p className="failed__detail">
            Everything already fetched is still on this device — carrying on picks up from there.
          </p>
        )}
        <div className="storage__actions">
          <button type="button" onClick={() => void start(tier.id, cached.includes(tier.id))}>
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              unload()
              setPhase('first-run')
            }}
          >
            Choose a different model
          </button>
        </div>
      </main>
    )
  }

  if ((phase === 'loading' || phase === 'warming') && tier) {
    return (
      // Wrapped in <main> so the loading screen sits on the same column as every
      // other screen; the bare <section> used to run the full width of the page.
      <main className="loading">
        <DownloadProgress tier={tier} progress={progress} fromCache={fromCache} />
        {phase === 'warming' && (
          <p className="download__note download__warming">
            Running one throwaway reply so your first real message does not pay the start-up cost.
          </p>
        )}
      </main>
    )
  }

  if (phase !== 'ready' || !tier) {
    return <main className="booting">Checking what this device can do…</main>
  }

  return (
    <main className="app">
      <header className="app__bar">
        <h1>PlaneMode</h1>
        <OfflineBadge />
      </header>

      {error && (
        <p className="app__error">
          {error.message}
          {isFatal(error.kind) && (
            <button type="button" className="app__retry" onClick={reloadModel}>
              Reload the model
            </button>
          )}
        </p>
      )}

      {saveFailed && (
        <p className="app__notice">
          This device would not store the conversation — usually a full disk. What is on screen
          still works, but it will not be here after a reload. Exporting or erasing from the
          storage panel below will free things up.
        </p>
      )}

      {trimmed > 0 && (
        <p className="app__notice">
          Earlier messages were trimmed — {trimmed} older{' '}
          {trimmed === 1 ? 'turn no longer fits' : 'turns no longer fit'} in the model's{' '}
          {tier.contextWindow}-token context window.
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
          <button type="button" onClick={() => stop()}>
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

      <StoragePanel tier={tier} disabled={streaming} onModelDeleted={handleModelDeleted} />
    </main>
  )
}
