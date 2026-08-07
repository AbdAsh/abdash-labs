import { useCallback, useEffect, useState } from 'react'
import { useSession, quotaFor, usedToday, linkGitHub, linkGoogle } from '@labs/platform'
import { Spread } from './components/Spread'
import { Verso, type UploadState, type Limits } from './components/Verso'
import { Recto } from './components/Recto'
import type { TurnData } from './components/Turn'
import {
  listNotebooks,
  createNotebook,
  renameNotebook,
  deleteNotebook,
  type Notebook,
} from './lib/notebooks'
import {
  listDocuments,
  deleteDocument,
  notebookIsRtl,
  readyDocuments,
  type DocumentRow,
} from './lib/documents'
import {
  listConversations,
  loadConversation,
  deleteConversation,
  type ConversationSummary,
} from './lib/conversations'
import { ingestFile } from './lib/ingest'
import { streamChat } from './lib/chat'
import { say } from './lib/errors'

const IDLE: UploadState = { status: 'idle', done: 0, total: 0, message: '' }

export default function App({ onSeeExample }: { onSeeExample?: () => void } = {}) {
  const { session } = useSession()

  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [turns, setTurns] = useState<TurnData[]>([])

  // Null until the caller's tier is known. Treating "not loaded yet" as zero
  // would show every limit as already reached on the first paint; treating it
  // as unlimited would let an upload start that the tier does not allow.
  const [limits, setLimits] = useState<Limits | null>(null)
  const [messagesUsed, setMessagesUsed] = useState(0)

  const [loading, setLoading] = useState(true)
  const [openingDocuments, setOpeningDocuments] = useState(false)
  const [upload, setUpload] = useState<UploadState>(IDLE)
  const [busy, setBusy] = useState(false)

  // Two error slots, not one. A notebook that would not delete has nothing to
  // do with the conversation, and reporting it in the transcript sends the
  // reader to the wrong page of the spread to find out what went wrong.
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [chatError, setChatError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const refreshNotebooks = useCallback(async () => {
    const list = await listNotebooks()
    setNotebooks(list)
    setActiveId((current) => current ?? list[0]?.id ?? null)
    return list
  }, [])

  const refreshUsage = useCallback(async () => {
    setMessagesUsed(await usedToday('recto', 'messages'))
  }, [])

  // Notebooks and the caller's caps, once the session exists.
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void (async () => {
      try {
        const [, notebookLimit, documentLimit, messageLimit, used] = await Promise.all([
          refreshNotebooks(),
          quotaFor('recto', 'notebooks'),
          quotaFor('recto', 'documents'),
          quotaFor('recto', 'messages'),
          usedToday('recto', 'messages'),
        ])
        if (cancelled) return
        setLimits({
          notebooks: notebookLimit,
          documents: documentLimit,
          messages: messageLimit,
        })
        setMessagesUsed(used)
      } catch (e) {
        if (!cancelled) setSourcesError(say(e))
      } finally {
        if (!cancelled) setLoading(false)
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
    setOpeningDocuments(true)
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
        if (!cancelled) setSourcesError(say(e))
      } finally {
        if (!cancelled) setOpeningDocuments(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const openConversation = useCallback(async (id: string | undefined) => {
    setConversationId(id)
    setChatError(null)
    if (!id) {
      setTurns([])
      return
    }
    try {
      setTurns(await loadConversation(id))
    } catch (e) {
      setChatError(say(e))
    }
  }, [])

  async function handleCreateNotebook() {
    setSourcesError(null)
    try {
      const created = await createNotebook('Untitled notebook')
      setNotebooks((prev) => [created, ...prev])
      setActiveId(created.id)
    } catch (e) {
      setSourcesError(say(e))
    }
  }

  async function handleRenameNotebook(id: string, title: string) {
    setNotebooks((prev) => prev.map((n) => (n.id === id ? { ...n, title } : n)))
    try {
      await renameNotebook(id, title)
    } catch (e) {
      setSourcesError(say(e))
      // The optimistic title is now a lie; put the server's back.
      await refreshNotebooks().catch(() => {})
    }
  }

  async function handleDeleteNotebook(id: string) {
    setSourcesError(null)
    try {
      await deleteNotebook(id)
      const remaining = notebooks.filter((n) => n.id !== id)
      setNotebooks(remaining)
      if (activeId === id) setActiveId(remaining[0]?.id ?? null)
    } catch (e) {
      setSourcesError(say(e))
    }
  }

  /** Re-reads what the server actually holds. Its own failure is reported as
   *  its own failure — folding it into the caller's catch would let a stale
   *  list turn a finished upload into a red "upload failed". */
  const reconcile = useCallback(
    async (notebookId: string) => {
      try {
        const [docs] = await Promise.all([listDocuments(notebookId), refreshNotebooks()])
        setDocuments(docs)
      } catch (e) {
        setSourcesError(say(e))
      }
    },
    [refreshNotebooks],
  )

  async function handleUpload(file: File) {
    if (!activeId) return
    setUpload({ status: 'reading', done: 0, total: 0, message: '' })
    try {
      await ingestFile(file, activeId, ({ phase, done, total }) =>
        setUpload({ status: phase, done, total, message: '' }),
      )
      setUpload(IDLE)
    } catch (e) {
      setUpload({ status: 'error', done: 0, total: 0, message: say(e) })
    }
    // Either way: on success for the new row and the cap it counts against, on
    // failure because ingestFile's rollback may have removed a half-built row
    // that is still on screen.
    await reconcile(activeId)
  }

  async function handleDeleteDocument(id: string) {
    if (!activeId) return
    setSourcesError(null)
    try {
      await deleteDocument(id)
      setDocuments((prev) => prev.filter((d) => d.id !== id))
    } catch (e) {
      setSourcesError(say(e))
    }
    // The per-notebook counts feed the global document cap, so they have to
    // follow a delete as closely as they follow an upload.
    await refreshNotebooks().catch(() => {})
  }

  async function handleDeleteConversation(id: string) {
    setChatError(null)
    try {
      await deleteConversation(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (conversationId === id) {
        setConversationId(undefined)
        setTurns([])
      }
    } catch (e) {
      setChatError(say(e))
    }
  }

  async function handleAsk(question: string) {
    if (!activeId) return
    setChatError(null)
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
      setChatError(say(e))
    } finally {
      setBusy(false)
      // Read back rather than incremented: a request rejected before the quota
      // was touched must not appear to have spent one.
      void refreshUsage().catch(() => {})
    }
  }

  const active = notebooks.find((n) => n.id === activeId) ?? null
  const ready = readyDocuments(documents)
  // Counted across every notebook: the tier grants a number of documents, not a
  // number per notebook, exactly as it grants a number of notebooks.
  const totalDocuments = notebooks.reduce((n, nb) => n + nb.documentCount, 0)
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
            loading={loading}
            notebooks={notebooks}
            activeId={activeId}
            limits={limits}
            totalDocuments={totalDocuments}
            documents={documents}
            documentsLoading={openingDocuments}
            upload={upload}
            error={sourcesError}
            onDismissError={() => setSourcesError(null)}
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
            loading={loading}
            hasNotebook={active !== null}
            notebookTitle={active?.title ?? 'No notebook yet'}
            readyCount={ready.length}
            unfinishedCount={documents.length - ready.length}
            conversations={conversations}
            conversationId={conversationId}
            turns={turns}
            busy={busy}
            error={chatError}
            messagesLeft={limits ? Math.max(limits.messages - messagesUsed, 0) : null}
            onDismissError={() => setChatError(null)}
            onAsk={handleAsk}
            onSelectConversation={(id) => void openConversation(id)}
            onDeleteConversation={(id) => void handleDeleteConversation(id)}
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
            {/* The way back. Someone who arrived on the recording and clicked
                through has an empty notebook in front of them; leaving them no
                route to the thing they were just looking at is a dead end. */}
            {onSeeExample && (
              <>
                {' '}
                <button type="button" className="link" onClick={onSeeExample}>
                  Back to the saved example
                </button>
              </>
            )}
          </p>
        ) : (
          <p>
            Signed in. Limits raised.
            {onSeeExample && (
              <>
                {' '}
                <button type="button" className="link" onClick={onSeeExample}>
                  Back to the saved example
                </button>
              </>
            )}
          </p>
        )}
      </footer>
    </>
  )
}
