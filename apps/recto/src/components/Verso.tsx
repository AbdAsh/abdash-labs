import { useState, type ReactNode } from 'react'
import type { Notebook } from '../lib/notebooks'
import type { DocumentRow } from '../lib/documents'

/** The caller's tier, as three resource caps. Null anywhere in the tree means
 *  "not known yet", which both gates treat as no slots rather than no ceiling. */
export interface Limits {
  notebooks: number
  documents: number
  messages: number
}

export interface UploadState {
  /** `reading` covers extraction and hashing, which happen entirely in the
   *  browser and are the slowest part of a long PDF. */
  status: 'idle' | 'reading' | 'indexing' | 'error'
  done: number
  total: number
  message: string
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <p className="notice" role="alert">
      <span>{text}</span>
      <button type="button" className="notice__dismiss" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </p>
  )
}

/** The verso: what the notebook is made of. */
export function Verso({
  loading,
  notebooks,
  activeId,
  limits,
  totalDocuments,
  documents,
  documentsLoading,
  upload,
  error,
  onDismissError,
  onSelectNotebook,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
  onUpload,
  onDeleteDocument,
  exhibit,
}: {
  loading: boolean
  notebooks: Notebook[]
  activeId: string | null
  limits: Limits | null
  totalDocuments: number
  documents: DocumentRow[]
  documentsLoading: boolean
  upload: UploadState
  error: string | null
  onDismissError: () => void
  onSelectNotebook: (id: string) => void
  onCreateNotebook: () => void
  onRenameNotebook: (id: string, title: string) => void
  onDeleteNotebook: (id: string) => void
  onUpload: (file: File) => void
  onDeleteDocument: (id: string) => void
  /** Present when this page is a saved run rather than the visitor's own
   *  notebook. Every control that would change something is withdrawn — a ×
   *  that deletes nothing is worse than no × — and this takes the dropzone's
   *  place, which is where a visitor looks when they want to add something. */
  exhibit?: ReactNode
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const frozen = exhibit !== undefined

  // Both caps fail closed while the tier is unknown. `quotaFor` answers 0 for a
  // lookup that failed, and 0 has to mean "no slots" rather than "no ceiling" —
  // otherwise a broken quota service quietly grants everyone everything.
  const atNotebookCap = !limits || notebooks.length >= limits.notebooks
  const atDocumentCap = !limits || totalDocuments >= limits.documents
  const busyUploading = upload.status === 'reading' || upload.status === 'indexing'

  return (
    <div className="verso">
      <header className="verso__head">
        <h1 className="wordmark">Recto</h1>
        <p className="tagline">Notebooks that cite their sources.</p>
      </header>

      {error && <Notice text={error} onDismiss={onDismissError} />}

      <section className="panel" aria-labelledby="notebooks-heading" aria-busy={loading}>
        <div className="panel__head">
          <h2 id="notebooks-heading">Notebooks</h2>
          <span className="tally">
            {loading ? '—' : `${notebooks.length} of ${limits ? limits.notebooks : '—'}`}
          </span>
        </div>

        {loading ? (
          <p className="empty">Opening your notebooks…</p>
        ) : notebooks.length === 0 ? (
          <p className="empty">No notebooks yet. Make one and add a document to it.</p>
        ) : (
          <ul className="stack">
            {notebooks.map((n) => (
              <li key={n.id} className="row" data-current={n.id === activeId || undefined}>
                {renaming === n.id ? (
                  <form
                    className="row__rename"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const title = draft.trim()
                      if (title) onRenameNotebook(n.id, title)
                      setRenaming(null)
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => setRenaming(null)}
                      aria-label="Notebook title"
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="row__main"
                    aria-current={n.id === activeId || undefined}
                    onClick={() => onSelectNotebook(n.id)}
                    onDoubleClick={() => {
                      if (frozen) return
                      setRenaming(n.id)
                      setDraft(n.title)
                    }}
                  >
                    <span className="row__title" dir="auto">
                      {n.title}
                    </span>
                    <span className="row__meta">
                      {n.documentCount} {n.documentCount === 1 ? 'document' : 'documents'}
                    </span>
                  </button>
                )}

                {frozen ? null : confirming === n.id ? (
                  <span className="row__confirm">
                    <button type="button" onClick={() => onDeleteNotebook(n.id)}>
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="row__discard"
                    aria-label={`Delete notebook ${n.title}`}
                    onClick={() => setConfirming(n.id)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!frozen && (
          <button
            type="button"
            className="action"
            onClick={onCreateNotebook}
            disabled={loading || atNotebookCap}
          >
            {!loading && atNotebookCap ? 'Notebook limit reached' : 'New notebook'}
          </button>
        )}
      </section>

      <section className="panel" aria-labelledby="documents-heading" aria-busy={documentsLoading}>
        <div className="panel__head">
          <h2 id="documents-heading">Documents</h2>
          {/* The cap is a total across every notebook, so the tally counts the
              same way. Showing this notebook's count against a global limit
              would read as three free slots when there are none. */}
          <span className="tally" title="Across all your notebooks">
            {loading ? '—' : `${totalDocuments} of ${limits ? limits.documents : '—'}`}
          </span>
        </div>

        {documentsLoading ? (
          <p className="empty">Opening…</p>
        ) : !activeId ? (
          <p className="empty">Make a notebook first.</p>
        ) : documents.length === 0 ? (
          <p className="empty">Nothing in this notebook yet.</p>
        ) : (
          <ul className="stack">
            {documents.map((d) => (
              <li key={d.id} className="row" data-status={d.status}>
                <span className="row__main row__main--static">
                  <span className="row__title" dir="auto">
                    {d.name}
                  </span>
                  {d.status === 'ready' ? (
                    <span className="row__meta">
                      {shortDate(d.createdAt)}
                      {d.pageCount ? ` · ${d.pageCount} pages` : ''}
                      {d.isRtl ? ' · RTL' : ''}
                    </span>
                  ) : (
                    // Retrieval skips anything unfinished, so saying so is the
                    // difference between "no answer" and "the app is broken".
                    <span className="row__meta row__meta--warn">
                      Unfinished — not searchable. Remove it and add it again.
                    </span>
                  )}
                </span>
                {!frozen && (
                  <button
                    type="button"
                    className="row__discard"
                    aria-label={`Delete ${d.name}`}
                    onClick={() => onDeleteDocument(d.id)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {frozen ? (
          <div className="exhibit-note">{exhibit}</div>
        ) : (
          <label className="dropzone" data-status={upload.status}>
            <input
              type="file"
              accept=".pdf,.txt,.md"
              disabled={busyUploading || loading || !activeId || atDocumentCap}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) onUpload(file)
              }}
            />
            {upload.status === 'reading' && <span>Reading the file…</span>}
            {upload.status === 'indexing' && (
              <span>
                Indexing… {upload.done} of {upload.total} passages
              </span>
            )}
            {upload.status === 'error' && <span className="error">{upload.message}</span>}
            {upload.status === 'idle' &&
              (loading ? (
                <span>…</span>
              ) : !activeId ? (
                <span>No notebook to add to yet.</span>
              ) : atDocumentCap ? (
                <span>
                  Document limit reached
                  {limits ? ` (${limits.documents} across all notebooks)` : ''}. Remove one to add
                  another.
                </span>
              ) : (
                <span>Add a PDF, .txt or .md</span>
              ))}
          </label>
        )}
      </section>
    </div>
  )
}
