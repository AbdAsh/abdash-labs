import { useCallback, useEffect, useMemo, useState } from 'react'
import { joinPages } from './lib/chunkers'
import {
  MAX_CONFIGS,
  expandMatrix,
  runBenchmark,
  type ConfigResult,
  type MatrixSelection,
} from './lib/engine'
import type { Question } from './lib/metrics'
import { loadPermalink, permalinkUrl, saveRun } from './lib/persist'
import { readyToRun } from './lib/questions'
import { SAMPLE_DOC, SAMPLE_QUESTIONS } from './samples/founding-documents'
import { CacheControls } from './components/CacheControls'
import { ConfigMatrix } from './components/ConfigMatrix'
import { Leaderboard } from './components/Leaderboard'
import { MetricChart } from './components/MetricChart'
import { QuestionBuilder } from './components/QuestionBuilder'
import { QuestionDrilldown } from './components/QuestionDrilldown'

interface Doc {
  name: string
  text: string
  fingerprint: string
  pageStarts?: number[]
}

const SAMPLE: Doc = {
  name: SAMPLE_DOC.title,
  text: SAMPLE_DOC.text,
  fingerprint: `sample:${SAMPLE_DOC.id}`,
}

/**
 * Recto currently ships fixed 1600/320 chunking. It is in the default matrix on
 * purpose: the point of this app is to put that default next to the alternatives
 * and let the numbers settle it.
 */
const DEFAULT_SELECTION: MatrixSelection = {
  chunkers: ['fixed', 'sentence-window', 'recursive'],
  sizes: [400, 1600],
  overlaps: [80],
  models: ['text-embedding-3-small'],
  ks: [5],
}

export function App() {
  const [doc, setDoc] = useState<Doc>(SAMPLE)
  const [questions, setQuestions] = useState<Question[]>(SAMPLE_QUESTIONS)
  const [selection, setSelection] = useState<MatrixSelection>(DEFAULT_SELECTION)
  const [results, setResults] = useState<ConfigResult[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localOnly, setLocalOnly] = useState(false)
  const [permalink, setPermalink] = useState<string | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)

  const status = useMemo(() => readyToRun(doc.text, questions), [doc.text, questions])
  const configCount = useMemo(() => {
    try {
      return expandMatrix(selection).length
    } catch {
      return 0
    }
  }, [selection])

  // A shared permalink renders read-only: the visitor sees someone else's
  // benchmark exactly as it was scored, without a session or a document.
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('run')
    if (!slug) return
    void (async () => {
      try {
        const loaded = await loadPermalink(slug)
        if (!loaded) {
          setError(`No benchmark found at ${slug}.`)
          return
        }
        setDoc({
          name: loaded.experiment.doc_name,
          text: '',
          fingerprint: loaded.experiment.doc_fingerprint,
        })
        setQuestions(loaded.experiment.questions)
        setResults(loaded.runs[0]?.results ?? [])
        setPermalink(permalinkUrl(slug))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const onUpload = useCallback(async (file: File) => {
    setLoadingDoc(true)
    setError(null)
    try {
      // Lazily imported: pdf.js is large and the sample flow never needs it.
      const { extractPages, contentHash } = await import('@labs/doc-core')
      const [pages, fingerprint] = await Promise.all([extractPages(file), contentHash(file)])
      const { text, pageStarts } = joinPages(pages)
      if (text.trim().length === 0) {
        throw new Error('No selectable text in that file. Scanned PDFs need OCR first.')
      }
      setDoc({ name: file.name, text, fingerprint, pageStarts })
      setQuestions([])
      setResults([])
      setPermalink(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingDoc(false)
    }
  }, [])

  const run = useCallback(async () => {
    setError(null)
    setResults([])
    setPermalink(null)
    setElapsed(null)
    const startedAt = performance.now()

    try {
      const configs = expandMatrix(selection)
      setProgress({ done: 0, total: configs.length })

      const out = await runBenchmark(
        doc.text,
        questions,
        configs,
        (done, total) => setProgress({ done, total }),
        { fingerprint: doc.fingerprint, pageStarts: doc.pageStarts },
      )
      setResults(out)
      setElapsed(performance.now() - startedAt)

      if (!localOnly) {
        const { slug } = await saveRun({
          docName: doc.name,
          docFingerprint: doc.fingerprint,
          questions,
          results: out,
        })
        setPermalink(permalinkUrl(slug))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }, [doc, questions, selection, localOnly])

  const running = progress !== null

  return (
    <main className="app">
      <header className="app-header">
        <h1>RAG Lab</h1>
        <p className="tagline">
          Retrieval benchmarks, not vibes. Chunk it every way, embed it, score it
          against labelled answers, share the result.
        </p>
        <CacheControls />
      </header>

      {error && <p className="error banner" role="alert">{error}</p>}

      <section className="panel">
        <h2>1 · Document</h2>
        <div className="toolbar">
          <button
            type="button"
            className={doc.fingerprint === SAMPLE.fingerprint ? 'chip chip-on' : 'chip'}
            onClick={() => {
              setDoc(SAMPLE)
              setQuestions(SAMPLE_QUESTIONS)
              setResults([])
              setPermalink(null)
            }}
          >
            Use the bundled sample
          </button>
          <label className="upload">
            <input
              type="file"
              accept="application/pdf,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void onUpload(file)
              }}
            />
            <span>{loadingDoc ? 'Extracting…' : 'Upload a PDF'}</span>
          </label>
        </div>
        <p className="doc-summary">
          <strong>{doc.name}</strong>
          {doc.text.length > 0 && <> · {doc.text.length.toLocaleString()} characters</>}
          {doc.fingerprint === SAMPLE.fingerprint && (
            <> · {SAMPLE_DOC.license}. 15 gold spans, hand-labelled.</>
          )}
        </p>
      </section>

      {doc.text.length > 0 && (
        <QuestionBuilder text={doc.text} questions={questions} onChange={setQuestions} />
      )}

      <ConfigMatrix
        selection={selection}
        onChange={setSelection}
        text={doc.text}
        questions={questions.map((q) => q.text)}
      />

      <section className="panel run-panel">
        <h2>3 · Run</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(e) => setLocalOnly(e.target.checked)}
          />
          <span>
            Local session only
            <em>
              Skips persistence and produces no permalink. Saved runs are readable
              by anyone with the link — the document name, question set and scores,
              never the document itself unless you uploaded it.
            </em>
          </span>
        </label>

        <button
          type="button"
          className="primary"
          onClick={run}
          disabled={running || !status.ok || configCount === 0 || doc.text.length === 0}
        >
          {running
            ? `Running ${progress.done}/${progress.total}…`
            : `Run ${configCount} configuration${configCount === 1 ? '' : 's'}`}
        </button>

        {running && (
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
          >
            <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}

        {!status.ok && doc.text.length > 0 && <p className="warn">{status.reason}</p>}
        {configCount === 0 && (
          <p className="warn">
            Pick at least one value in every row, and keep the total at or below {MAX_CONFIGS}.
          </p>
        )}

        {elapsed !== null && (
          <p className="dim">Completed in {(elapsed / 1000).toFixed(1)} s.</p>
        )}
        {permalink && (
          <p className="permalink">
            Permalink: <a href={permalink}>{permalink}</a>
          </p>
        )}
      </section>

      <Leaderboard results={results} />
      <MetricChart results={results} />
      {doc.text.length > 0 && (
        <QuestionDrilldown questions={questions} results={results} text={doc.text} />
      )}

      <footer className="app-footer">
        <p>
          Embeddings are cached in this browser's IndexedDB and never written to the
          database — a twelve-config run over a hundred-page document is about 11 MB
          of vectors, and the database is 500 MB shared across seven apps. The
          server stores configuration, questions, gold spans and scores. Nothing else.
        </p>
      </footer>
    </main>
  )
}
