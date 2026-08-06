import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GraphView } from './components/GraphView'
import { NodePanel } from './components/NodePanel'
import { EdgePanel } from './components/EdgePanel'
import { Filters } from './components/Filters'
import { applyCorrections, type Correction } from './lib/corrections'
import { estimateCost, formatUsd, MAX_PAGES, type CostEstimate } from './lib/cost'
import { say } from './lib/errors'
import { pagesFromFile, runExtraction, toSourceChunks, type SourceChunk } from './lib/extract'
import type { Graph } from './lib/graph'
import { loadGraph, saveCorrections, saveGraph } from './lib/persist'
import { ENTITY_TYPES, type EntityType } from './lib/validate'
import { DEMO_DOC_NAME, DEMO_GRAPH, demoChunkPages } from './demo'

type Stage = 'ready' | 'opening' | 'estimating' | 'extracting'

const ALL_TYPES = new Set<EntityType>(ENTITY_TYPES)

/** What a failed run leaves behind. Never the demo graph under someone else's name. */
const EMPTY_GRAPH: Graph = {
  nodes: [],
  edges: [],
  stats: { chunks: 0, keptRelations: 0, droppedRelations: 0, unresolvedRelations: 0 },
}

interface Pending {
  chunks: SourceChunk[]
  estimate: CostEstimate
  docName: string
  chunkPages: Map<string, number>
}

export default function App() {
  const [baseGraph, setBaseGraph] = useState<Graph>(DEMO_GRAPH)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [docName, setDocName] = useState(DEMO_DOC_NAME)
  const [chunkPages, setChunkPages] = useState<Map<string, number>>(demoChunkPages)
  const [stage, setStage] = useState<Stage>('ready')
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 })
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Non-fatal things the user still has to be told. A partial graph, a dead link. */
  const [notice, setNotice] = useState<string | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [isDemo, setIsDemo] = useState(true)
  /** False while looking at someone else's permalink: corrections cannot be saved. */
  const [canEdit, setCanEdit] = useState(true)

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [isolatedId, setIsolatedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visibleTypes, setVisibleTypes] = useState<Set<EntityType>>(ALL_TYPES)

  const abort = useRef<AbortController | null>(null)

  // Corrections are replayed over the stored graph rather than baked into it,
  // so the automatic result underneath stays inspectable and reversible.
  const graph = useMemo(
    () => (corrections.length > 0 ? applyCorrections(baseGraph, corrections) : baseGraph),
    [baseGraph, corrections],
  )

  const selectedNode = useMemo(
    () => graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  )
  const selectedEdge = useMemo(
    () => graph.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [graph.edges, selectedEdgeId],
  )

  // A permalink in the URL wins over the demo.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('g')
    if (!wanted) return
    let cancelled = false
    setStage('opening')
    loadGraph(wanted)
      .then((saved) => {
        if (cancelled) return
        if (!saved) {
          // A slug that resolves to nothing must say so. Silently falling back
          // to the demo would present it as the graph the link asked for.
          setNotice(`No graph is stored at “${wanted}”. Showing the demo instead.`)
          return
        }
        setBaseGraph(saved.graph)
        setCorrections(saved.corrections)
        setDocName(saved.docName)
        setChunkPages(saved.chunkPages)
        setSlug(saved.slug)
        setIsDemo(false)
        setCanEdit(saved.isOwner)
        if (!saved.isOwner) {
          setNotice('You are viewing a shared graph. Merges and splits stay on this device.')
        }
      })
      .catch((e: unknown) => setError(say(e)))
      .finally(() => {
        if (!cancelled) setStage('ready')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onToggleType = useCallback((type: EntityType) => {
    setVisibleTypes((current) => {
      const next = new Set(current)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next.size === 0 ? ALL_TYPES : next
    })
  }, [])

  // Nothing about the current graph changes here. Picking a file is not the
  // same as running it, and relabelling the demo with a name it has nothing to
  // do with is a lie the user has no way to notice.
  const onPickFile = useCallback(async (file: File) => {
    setError(null)
    setNotice(null)
    setStage('estimating')
    try {
      const pages = await pagesFromFile(file)
      const chunks = toSourceChunks(pages)
      setPending({
        chunks,
        estimate: estimateCost(
          chunks.map((c) => c.content),
          pages.length,
        ),
        docName: file.name,
        chunkPages: new Map(chunks.map((c) => [c.id, c.page])),
      })
    } catch (e) {
      setError(say(e))
    } finally {
      setStage('ready')
    }
  }, [])

  const onRun = useCallback(async () => {
    if (!pending) return
    const controller = new AbortController()
    abort.current = controller

    setStage('extracting')
    setError(null)
    setNotice(null)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setIsolatedId(null)
    setCorrections([])
    setSlug(null)
    setIsDemo(false)
    setCanEdit(true)
    setDocName(pending.docName)
    setChunkPages(pending.chunkPages)
    setBaseGraph(EMPTY_GRAPH)
    setProgress({ done: 0, total: pending.chunks.length, failed: 0 })

    try {
      const result = await runExtraction(pending.chunks, {
        signal: controller.signal,
        // Nodes appear as chunks land. Thirty to ninety seconds of a graph
        // assembling itself is good theatre and honest progress at once.
        onProgress: (p) => {
          setProgress({ done: p.done, total: p.total, failed: p.failed })
          setBaseGraph(p.graph)
        },
      })
      setBaseGraph(result.graph)
      setPending(null)

      // A partial graph is worth keeping and worth admitting to. Saying nothing
      // would present four fifths of a document as all of it. Counting what was
      // actually read — rather than what failed — also covers the passages a
      // quota stop meant were never attempted at all.
      const read = result.extractions.length
      const total = result.chunks.length
      if (read < total) {
        const why = controller.signal.aborted
          ? 'You stopped the run'
          : result.stoppedEarly
            ? 'The daily allowance ran out'
            : 'Some passages could not be read'
        setNotice(`${why}. This graph covers ${read} of ${total} passages, not the whole document.`)
      }
    } catch (e) {
      // The only throw is a refusal on the very first chunk, so there is no
      // partial result to keep — and the previous graph must not stand in for one.
      setError(say(e))
      setBaseGraph(EMPTY_GRAPH)
    } finally {
      abort.current = null
      setStage('ready')
    }
  }, [pending])

  const onCancel = useCallback(() => abort.current?.abort(), [])

  // The save is deliberately outside the state updater: StrictMode invokes
  // updaters twice, and a correction that posts itself to the database twice is
  // a correction that is hard to reason about.
  const commitCorrections = useCallback(
    (next: Correction[]) => {
      setCorrections(next)
      if (slug && canEdit) void saveCorrections(slug, next).catch((e) => setError(say(e)))
    },
    [canEdit, slug],
  )

  const pushCorrection = useCallback(
    (correction: Correction) => commitCorrections([...corrections, correction]),
    [commitCorrections, corrections],
  )

  // Automatic resolution is undoable by splitting; a mis-drag is not, unless
  // this exists. On a touch screen a merge is one clumsy gesture away.
  const onUndoCorrection = useCallback(
    () => commitCorrections(corrections.slice(0, -1)),
    [commitCorrections, corrections],
  )

  const onShare = useCallback(async () => {
    setError(null)
    try {
      const created = await saveGraph(docName, baseGraph, corrections, chunkPages)
      setSlug(created)
      setCanEdit(true)
      const url = new URL(window.location.href)
      url.searchParams.set('g', created)
      window.history.replaceState(null, '', url)
      setNotice('Permalink created — the address bar now holds the shareable link.')
    } catch (e) {
      setError(say(e))
    }
  }, [baseGraph, chunkPages, corrections, docName])

  const busy = stage === 'extracting' || stage === 'estimating' || stage === 'opening'
  const shareable = !isDemo && stage === 'ready' && graph.nodes.length > 0

  return (
    <div className="app">
      <header className="app-head">
        <div>
          <h1>GraphRead</h1>
          <p className="doc-name">
            {docName}
            {isDemo && <span className="badge">demo</span>}
            {!canEdit && <span className="badge">shared</span>}
          </p>
        </div>
        <div className="head-actions">
          {corrections.length > 0 && stage === 'ready' && (
            <button type="button" className="link-button" onClick={onUndoCorrection}>
              Undo last correction
            </button>
          )}
          <label className={`file-button${busy ? ' is-disabled' : ''}`}>
            {stage === 'estimating' ? 'Reading the document…' : 'Open a document'}
            <input
              type="file"
              accept="application/pdf,text/plain"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                // Reset, so picking the same file twice still fires a change.
                e.target.value = ''
                if (file) void onPickFile(file)
              }}
            />
          </label>
          {shareable && (
            <button type="button" onClick={() => void onShare()} disabled={slug !== null}>
              {slug ? 'Permalink created' : 'Create a permalink'}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}

      {pending && stage !== 'extracting' && (
        <div className="estimate" role="dialog" aria-label="Cost estimate">
          <p>
            <strong>{pending.docName}</strong> — {pending.estimate.pages} pages ·{' '}
            {pending.estimate.chunks} passages · about{' '}
            <strong>{formatUsd(pending.estimate.usd)}</strong> of extraction, taking roughly{' '}
            {estimateSeconds(pending.estimate.chunks)}.
          </p>
          {pending.estimate.overPageCap ? (
            <p className="error">
              This document is over the {MAX_PAGES}-page cap. Trim it and try again.
            </p>
          ) : (
            <button type="button" onClick={() => void onRun()}>
              Extract the graph
            </button>
          )}
          <button type="button" className="link-button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}

      {stage === 'extracting' && (
        <div className="progress" role="status" aria-live="polite">
          <div
            className="progress-bar"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
          >
            <div
              style={{
                width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <span>
            Reading passage {progress.done} of {progress.total}
            {progress.failed > 0 && ` · ${progress.failed} could not be read`}
          </span>
          <button type="button" className="link-button" onClick={onCancel}>
            Stop and keep what is done
          </button>
        </div>
      )}

      {stage === 'opening' && (
        <p className="progress" role="status" aria-busy="true">
          Opening the shared graph…
        </p>
      )}

      <Filters
        graph={graph}
        query={query}
        visibleTypes={visibleTypes}
        onQueryChange={setQuery}
        onToggleType={onToggleType}
      />

      <main className="workspace">
        <GraphView
          graph={graph}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
          visibleTypes={visibleTypes}
          query={query}
          isolatedId={isolatedId}
          onSelectNode={setSelectedNodeId}
          onSelectEdge={setSelectedEdgeId}
          onIsolate={setIsolatedId}
          onMergeNodes={(a, b) => pushCorrection({ kind: 'merge', ids: [a, b] })}
        />

        {selectedNode && (
          <NodePanel
            graph={graph}
            node={selectedNode}
            chunkPages={chunkPages}
            onClose={() => setSelectedNodeId(null)}
            onSelectNode={(id) => {
              setSelectedEdgeId(null)
              setSelectedNodeId(id)
            }}
            onIsolate={setIsolatedId}
            onSplit={(id, alias) => pushCorrection({ kind: 'split', id, alias })}
          />
        )}

        {!selectedNode && selectedEdge && (
          <EdgePanel
            graph={graph}
            edge={selectedEdge}
            chunkPages={chunkPages}
            onClose={() => setSelectedEdgeId(null)}
            onSelectNode={(id) => {
              setSelectedEdgeId(null)
              setSelectedNodeId(id)
            }}
          />
        )}
      </main>
    </div>
  )
}

/** Four chunks in flight at roughly three seconds each — deliberately rounded. */
function estimateSeconds(chunks: number): string {
  const seconds = Math.max(5, Math.round((chunks / 4) * 3))
  if (seconds < 60) return `${seconds} seconds`
  return `${Math.round(seconds / 60)} minutes`
}
