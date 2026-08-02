import { useCallback, useEffect, useState } from 'react'
import { useSession, quotaFor, linkGitHub, linkGoogle } from '@labs/platform'
import { Spread } from './components/Spread'
import { Verso, type UploadState } from './components/Verso'
import { Recto } from './components/Recto'
import type { TurnData } from './components/Turn'
import {
  listNotebooks,
  createNotebook,
  renameNotebook,
  deleteNotebook,
  type Notebook,
} from './lib/notebooks'
import { listDocuments, deleteDocument, notebookIsRtl, type DocumentRow } from './lib/documents'
import {
  listConversations,
  loadConversation,
  type ConversationSummary,
} from './lib/conversations'
import { ingestFile } from './lib/ingest'
import { streamChat } from './lib/chat'

const IDLE: UploadState = { status: 'idle', done: 0, total: 0, message: '' }

function say(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function App() {
  const { session } = useSession()

  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [turns, setTurns] = useState<TurnData[]>([])

  const [limits, setLimits] = useState({ notebooks: 0, documents: 0 })
  const [upload, setUpload] = useState<UploadState>(IDLE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const refreshNotebooks = useCallback(async () => {
    const list = await listNotebooks()
    setNotebooks(list)
    setActiveId((current) => current ?? list[0]?.id ?? null)
    return list
  }, [])

  // Notebooks and the caller's caps, once the session exists.
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void (async () => {
      try {
        const [, nb, docs] = await Promise.all([
          refreshNotebooks(),
          quotaFor('recto', 'notebooks'),
          quotaFor('recto', 'documents'),
        ])
        if (!cancelled) setLimits({ notebooks: nb, documents: docs })
      } catch (e) {
        if (!cancelled) setError(say(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session, refreshNotebooks])

  // Everything below the notebook is scoped to it, so it all reloads together.
  useEffect(() => {
    if (!activeId) {
      setDocuments([])
      setConversations([])
      return
    }
    let cancelled = false
    setTurns([])
    setConversationId(undefined)
    void (async () => {
      try {
        const [docs, convos] = await Promise.all([
          listDocuments(activeId),
          listConversations(activeId),
        ])
        if (cancelled) return
        setDocuments(docs)
        setConversations(convos)
      } catch (e) {
        if (!cancelled) setError(say(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const openConversation = useCallback(async (id: string | undefined) => {
    setConversationId(id)
    setError(null)
    if (!id) {
      setTurns([])
      return
    }
    try {
      setTurns(await loadConversation(id))
    } catch (e) {
      setError(say(e))
    }
  }, [])

  async function handleCreateNotebook() {
    setError(null)
    try {
      const created = await createNotebook('Untitled notebook')
      setNotebooks((prev) => [created, ...prev])
      setActiveId(created.id)
    } catch (e) {
      setError(say(e))
    }
  }

  async function handleRenameNotebook(id: string, title: string) {
    setNotebooks((prev) => prev.map((n) => (n.id === id ? { ...n, title } : n)))
    try {
      await renameNotebook(id, title)
    } catch (e) {
      setError(say(e))
      void refreshNotebooks()
    }
  }

  async function handleDeleteNotebook(id: string) {
    try {
      await deleteNotebook(id)
      const remaining = notebooks.filter((n) => n.id !== id)
      setNotebooks(remaining)
      if (activeId === id) setActiveId(remaining[0]?.id ?? null)
    } catch (e) {
      setError(say(e))
    }
  }

  async function handleUpload(file: File) {
    if (!activeId) return
    setUpload({ status: 'working', done: 0, total: 0, message: '' })
    try {
      await ingestFile(file, activeId, (done, total) =>
        setUpload({ status: 'working', done, total, message: '' }),
      )
      setUpload(IDLE)
      setDocuments(await listDocuments(activeId))
      void refreshNotebooks()
    } catch (e) {
      setUpload({ status: 'error', done: 0, total: 0, message: say(e) })
    }
  }

  async function handleDeleteDocument(id: string) {
    if (!activeId) return
    try {
      await deleteDocument(id)
      setDocuments((prev) => prev.filter((d) => d.id !== id))
      void refreshNotebooks()
    } catch (e) {
      setError(say(e))
    }
  }

  async function handleAsk(question: string) {
    if (!activeId) return
    setError(null)
    setBusy(true)
    const index = turns.length
    setTurns((t) => [...t, { question, answer: '', citations: [] }])

    const patch = (fn: (turn: TurnData) => TurnData) =>
      setTurns((t) => t.map((turn, i) => (i === index ? fn(turn) : turn)))

    try {
      const { conversationId: id } = await streamChat(
        question,
        activeId,
        conversationId,
        (token) => patch((turn) => ({ ...turn, answer: turn.answer + token })),
        (citations) => patch((turn) => ({ ...turn, citations })),
      )
      if (id !== conversationId) {
        setConversationId(id)
        setConversations(await listConversations(activeId))
      }
    } catch (e) {
      setError(say(e))
      patch((turn) => (turn.answer ? turn : { ...turn, answer: '—' }))
    } finally {
      setBusy(false)
    }
  }

  const active = notebooks.find((n) => n.id === activeId) ?? null
  // Any right-to-left document mirrors the whole spread, exactly as recto and
  // verso swap sides in an Arabic or Hebrew book.
  const dir = notebookIsRtl(documents) ? 'rtl' : 'ltr'

  return (
    <>
      <Spread
        dir={dir}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
        verso={
          <Verso
            notebooks={notebooks}
            activeId={activeId}
            notebookLimit={limits.notebooks}
            documentLimit={limits.documents}
            documents={documents}
            upload={upload}
            onSelectNotebook={(id) => {
              setActiveId(id)
              setDrawerOpen(false)
            }}
            onCreateNotebook={handleCreateNotebook}
            onRenameNotebook={handleRenameNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onUpload={handleUpload}
            onDeleteDocument={handleDeleteDocument}
          />
        }
        recto={
          <Recto
            notebookTitle={active?.title ?? 'No notebook yet'}
            documentCount={documents.length}
            conversations={conversations}
            conversationId={conversationId}
            turns={turns}
            busy={busy}
            error={error}
            onAsk={handleAsk}
            onSelectConversation={(id) => void openConversation(id)}
            onNewConversation={() => void openConversation(undefined)}
          />
        }
      />

      <footer className="colophon" dir={dir}>
        {session?.isAnonymous ? (
          <p>
            You are working anonymously — nobody else can see these notebooks.{' '}
            <button type="button" className="link" onClick={() => void linkGitHub()}>
              Link GitHub
            </button>{' '}
            or{' '}
            <button type="button" className="link" onClick={() => void linkGoogle()}>
              Google
            </button>{' '}
            to raise the limits. Your existing notebooks stay yours.
          </p>
        ) : (
          <p>Signed in. Limits raised.</p>
        )}
      </footer>
    </>
  )
}
