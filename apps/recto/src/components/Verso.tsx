import { useState } from 'react'
import type { Notebook } from '../lib/notebooks'
import type { DocumentRow } from '../lib/documents'

export interface UploadState {
  status: 'idle' | 'working' | 'error'
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

/** The verso: what the notebook is made of. */
export function Verso({
  notebooks,
  activeId,
  notebookLimit,
  documentLimit,
  documents,
  upload,
  onSelectNotebook,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
  onUpload,
  onDeleteDocument,
}: {
  notebooks: Notebook[]
  activeId: string | null
  notebookLimit: number
  documentLimit: number
  documents: DocumentRow[]
  upload: UploadState
  onSelectNotebook: (id: string) => void
  onCreateNotebook: () => void
  onRenameNotebook: (id: string, title: string) => void
  onDeleteNotebook: (id: string) => void
  onUpload: (file: File) => void
  onDeleteDocument: (id: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  const atNotebookCap = notebookLimit > 0 && notebooks.length >= notebookLimit
  const atDocumentCap = documentLimit > 0 && documents.length >= documentLimit

  return (
    <div className="verso">
      <header className="verso__head">
        <h1 className="wordmark">Recto</h1>
        <p className="tagline">Notebooks that cite their sources.</p>
      </header>

      <section className="panel" aria-labelledby="notebooks-heading">
        <div className="panel__head">
          <h2 id="notebooks-heading">Notebooks</h2>
          <span className="tally">
            {notebooks.length} of {notebookLimit || '—'}
          </span>
        </div>

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

              {confirming === n.id ? (
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

        <button
          type="button"
          className="action"
          onClick={onCreateNotebook}
          disabled={atNotebookCap}
        >
          {atNotebookCap ? 'Notebook limit reached' : 'New notebook'}
        </button>
      </section>

      <section className="panel" aria-labelledby="documents-heading">
        <div className="panel__head">
          <h2 id="documents-heading">Documents</h2>
          <span className="tally">
            {documents.length} of {documentLimit || '—'}
          </span>
        </div>

        {documents.length === 0 ? (
          <p className="empty">Nothing in this notebook yet.</p>
        ) : (
          <ul className="stack">
            {documents.map((d) => (
              <li key={d.id} className="row">
                <span className="row__main row__main--static">
                  <span className="row__title" dir="auto">
                    {d.name}
                  </span>
                  <span className="row__meta">
                    {shortDate(d.createdAt)}
                    {d.pageCount ? ` · ${d.pageCount} pages` : ''}
                    {d.isRtl ? ' · RTL' : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="row__discard"
                  aria-label={`Delete ${d.name}`}
                  onClick={() => onDeleteDocument(d.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className="dropzone" data-status={upload.status}>
          <input
            type="file"
            accept=".pdf,.txt,.md"
            disabled={upload.status === 'working' || !activeId || atDocumentCap}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onUpload(file)
            }}
          />
          {upload.status === 'working' && (
            <span>
              Indexing… {upload.done}/{upload.total} passages
            </span>
          )}
          {upload.status === 'error' && <span className="error">{upload.message}</span>}
          {upload.status === 'idle' &&
            (atDocumentCap ? (
              <span>Document limit reached for this tier.</span>
            ) : (
              <span>Add a PDF, .txt or .md</span>
            ))}
        </label>
      </section>
    </div>
  )
}
