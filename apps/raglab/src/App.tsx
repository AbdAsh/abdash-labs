import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthGate } from '@labs/platform'
import { joinPages } from './lib/chunkers'
import {
  BenchmarkFailure,
  MAX_CONFIGS,
  matrixState,
  runBenchmark,
  type ConfigResult,
  type MatrixSelection,
} from './lib/engine'
import type { Question } from './lib/metrics'
import { loadPermalink, permalinkUrl, saveRun, type ExperimentRecord } from './lib/persist'
import { readyToRun } from './lib/questions'
import { SAMPLE_DOC, SAMPLE_QUESTIONS } from './samples/founding-documents'
import { CacheControls } from './components/CacheControls'
import { ConfigMatrix } from './components/ConfigMatrix'
import { ExampleRun } from './components/ExampleRun'
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

type Shared =
  | { state: 'none' }
  | { state: 'loading'; slug: string }
  | { state: 'missing'; slug: string }
  | { state: 'loaded'; slug: string; experiment: ExperimentRecord }

/**
 * `example` shows a benchmark that already ran; `live` is the tool.
 *
 * The default is `example`, and that is a judgement about who arrives here. A
 * first-time visitor is deciding in about ten seconds whether this thing measures
 * anything, and the live path answers that question in ninety seconds while
 * spending one of their two daily runs. Opening on a real, finished result costs
 * them nothing and shows them the part worth seeing — the per-question
 * diagnostics — immediately. The live tool is one button away and unchanged.
 */
type Mode = 'example' | 'live'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function App() {
  const [doc, setDoc] = useState<Doc>(SAMPLE)
  const [questions, setQuestions] = useState<Question[]>(SAMPLE_QUESTIONS)
  const [selection, setSelection] = useState<MatrixSelection>(DEFAULT_SELECTION)
  const [results, setResults] = useState<ConfigResult[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [localOnly, setLocalOnly] = useState(false)
  const [permalink, setPermalink] = useState<string | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [shared, setShared] = useState<Shared>(() => {
    const slug = new URLSearchParams(window.location.search).get('run')
    return slug ? { state: 'loading', slug } : { state: 'none' }
  })
  const [mode, setMode] = useState<Mode>('example')
  const abort = useRef<AbortController | null>(null)

  const status = useMemo(() => readyToRun(doc.text, questions), [doc.text, questions])
  const matrix = useMemo(() => matrixState(selection), [selection])
  const configCount = matrix.configs.length

  // A shared permalink renders read-only: the visitor sees someone else's
  // benchmark exactly as it was scored, without a session or a document.
  useEffect(() => {
    if (shared.state !== 'loading') return
    const { slug } = shared
    void (async () => {
      try {
        const loaded = await loadPermalink(slug)
        if (!loaded) {
          setShared({ state: 'missing', slug })
          return
        }
        setQuestions(loaded.experiment.questions)
        setResults(loaded.runs[0]?.results ?? [])
        setPermalink(permalinkUrl(slug))
        setShared({ state: 'loaded', slug, experiment: loaded.experiment })
      } catch (e) {
        setError(message(e))
        setShared({ state: 'missing', slug })
      }
    })()
  }, [shared])

  const startOver = useCallback(() => {
    window.history.replaceState(null, '', window.location.pathname)
    setShared({ state: 'none' })
    setMode('live')
    setDoc(SAMPLE)
    setQuestions(SAMPLE_QUESTIONS)
    setResults([])
    setPermalink(null)
    setError(null)
    setNotice(null)
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
      // Gold spans are offsets into a specific text. Carrying them across an
      // upload would point them at whatever now happens to sit at those indices —
      // a benchmark that runs cleanly and scores the wrong passages.
      setQuestions([])
      setResults([])
      setPermalink(null)
      setNotice(null)
    } catch (e) {
      setError(message(e))
    } finally {
      setLoadingDoc(false)
    }
  }, [])

  const run = useCallback(async () => {
    setError(null)
    setNotice(null)
    setResults([])
    setPermalink(null)
    setElapsed(null)
    const startedAt = performance.now()
    const controller = new AbortController()
    abort.current = controller

    let out: ConfigResult[]
    try {
      setProgress({ done: 0, total: matrix.configs.length })
      out = await runBenchmark(
        doc.text,
        questions,
        matrix.configs,
        (done, total) => setProgress({ done, total }),
        { fingerprint: doc.fingerprint, pageStarts: doc.pageStarts, signal: controller.signal },
      )
      setResults(out)
      setElapsed(performance.now() - startedAt)
    } catch (e) {
      setError(message(e))
      if (e instanceof BenchmarkFailure && e.completed.length > 0) {
        // The finished configurations are real measurements and were paid for.
        // They are shown, and deliberately not saved: a permalink missing a third
        // of its matrix is the "comparison you did not ask for" that the config
        // cap exists to prevent.
        setResults(e.completed)
        setNotice(
          `${e.completed.length} of ${e.completed.length + e.remaining} configurations `
          + 'finished. Their scores are valid and comparable with each other, but the run '
          + 'is incomplete so it has not been saved.',
        )
      }
      return
    } finally {
      abort.current = null
      setProgress(null)
    }

    if (localOnly) return
    try {
      const { slug } = await saveRun({
        docName: doc.name,
        docFingerprint: doc.fingerprint,
        docText: doc.text,
        questions,
        results: out,
      })
      setPermalink(permalinkUrl(slug))
    } catch (e) {
      // The benchmark succeeded; only the permalink did not. Say which.
      setNotice(`The scores below are complete. Saving the permalink failed: ${message(e)}`)
    }
  }, [doc, questions, matrix, localOnly])

  const running = progress !== null

  if (shared.state === 'loading') {
    return (
      <main className="app">
        <header className="app-header"><h1>RAG Lab</h1></header>
        <section className="panel"><p className="dim">Loading shared benchmark…</p></section>
      </main>
    )
  }

  if (shared.state === 'loaded') {
    const { experiment } = shared
    return (
      <main className="app">
        <header className="app-header">
          <h1>RAG Lab</h1>
          <p className="tagline">
            A shared benchmark. Someone else ran this; you are reading the result.
          </p>
        </header>

        <section className="panel">
          <h2>{experiment.doc_name}</h2>
          <p className="doc-summary">
            {experiment.questions.length} labelled questions ·{' '}
            {results.length} configuration{results.length === 1 ? '' : 's'} ·
            {' '}scored {new Date(experiment.created_at).toLocaleDateString()}
          </p>
          <p className="lede">
            The document text is not part of a permalink — only its name, its
            fingerprint, the question set with its gold passages, and the scores.
            The diagnostics below work from those alone.
          </p>
          <button type="button" className="primary" onClick={startOver}>
            Run your own benchmark
          </button>
        </section>

        {results.length === 0 && (
          <section className="panel">
            <p className="warn">
              This experiment was saved without a completed run. There is nothing to score.
            </p>
          </section>
        )}

        <Leaderboard results={results} />
        <MetricChart results={results} />
        <QuestionDrilldown questions={experiment.questions} results={results} />

        <Footer />
      </main>
    )
  }

  if (mode === 'example') {
    return (
      <main className="app">
        <header className="app-header">
          <h1>RAG Lab</h1>
          <p className="tagline">
            Retrieval benchmarks, not vibes. Chunk it every way, embed it, score it
            against labelled answers, share the result.
          </p>
        </header>
        <ExampleRun onRunYourOwn={() => setMode('live')} />
        <Footer />
      </main>
    )
  }

  const tool = (
    <main className="app">
      <header className="app-header">
        <h1>RAG Lab</h1>
        <p className="tagline">
          Retrieval benchmarks, not vibes. Chunk it every way, embed it, score it
          against labelled answers, share the result.
        </p>
        <div className="toolbar mode-switch">
          <button
            type="button"
            className="chip"
            disabled={running}
            onClick={() => setMode('example')}
          >
            ← See the finished example
          </button>
          <span className="dim">Free, instant, and no run off your daily two.</span>
        </div>
        <CacheControls />
      </header>

      {shared.state === 'missing' && (
        <p className="error banner" role="alert">
          No benchmark at <code>{shared.slug}</code>. The link may be mistyped, or the run
          may have been deleted by whoever created it. Everything below is a fresh start.
        </p>
      )}
      {error && <p className="error banner" role="alert">{error}</p>}
      {notice && <p className="warn banner" role="status">{notice}</p>}

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
              disabled={loadingDoc || running}
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
            <>
              {' '}· {SAMPLE_DOC.source} · {SAMPLE_DOC.license}. 15 gold spans,
              hand-labelled.
            </>
          )}
        </p>
        {loadingDoc && <p className="dim">Extracting text and fingerprinting…</p>}
      </section>

      {doc.text.length > 0 && (
        <QuestionBuilder text={doc.text} questions={questions} onChange={setQuestions} />
      )}

      <ConfigMatrix
        selection={selection}
        onChange={setSelection}
        matrix={matrix}
        text={doc.text}
        questions={questions}
      />

      <section className="panel run-panel">
        <h2>3 · Run</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={localOnly}
            disabled={running}
            onChange={(e) => setLocalOnly(e.target.checked)}
          />
          <span>
            Local session only
            <em>
              Skips persistence and produces no permalink. A saved run is readable by
              anyone with the link: the document name and fingerprint, the questions
              with their gold passages, and the scores. The document text itself is
              never uploaded.
            </em>
          </span>
        </label>

        <div className="toolbar">
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
            <button type="button" className="secondary" onClick={() => abort.current?.abort()}>
              Cancel — keep what finished
            </button>
          )}
        </div>

        {running && (
          <>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <p className="dim">
              {progress.done === 0
                ? 'Embedding the question set, then the first chunking. Nothing is cached yet '
                  + 'on a first run, so this step is the slowest.'
                : `Configuration ${progress.done + 1} of ${progress.total}.`}
            </p>
          </>
        )}

        {!status.ok && doc.text.length > 0 && <p className="warn">{status.reason}</p>}
        {doc.text.length === 0 && (
          <p className="warn">Pick the sample or upload a document first.</p>
        )}
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
        {results.length > 0 && !permalink && localOnly && (
          <p className="dim">Local session only — nothing was saved and there is no link.</p>
        )}
      </section>

      {results.length === 0 && !running && (
        <section className="panel">
          <h2>Results</h2>
          <p className="lede">
            Nothing scored yet. A run produces a ranked leaderboard, a curve of MRR
            against chunk size, and a per-question breakdown that names the reason each
            configuration missed — a chunk too small to hold the answer, a chunker that
            cut through it, or a ranking that buried it below k.
          </p>
        </section>
      )}

      <Leaderboard results={results} />
      <MetricChart results={results} />
      <QuestionDrilldown questions={questions} results={results} text={doc.text} />

      <Footer />
    </main>
  )

  // Only the tool is gated. A session is what lets the Edge Function charge a run
  // and what makes a saved permalink yours; neither is in play until this point,
  // and the example and the shared-run views above deliberately reach neither.
  return <AuthGate>{tool}</AuthGate>
}

function Footer() {
  return (
    <footer className="app-footer">
      <p>
        Embeddings are cached in this browser's IndexedDB and never written to the
        database — a twelve-config run over a hundred-page document is about 11 MB
        of vectors, and the database is 500 MB shared across seven apps. The
        server stores configuration, questions, gold spans and scores. Nothing else.
      </p>
    </footer>
  )
}
