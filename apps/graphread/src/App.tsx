import { useCallback, useEffect, useMemo, useState } from 'react'
import { GraphView } from './components/GraphView'
import { NodePanel } from './components/NodePanel'
import { EdgePanel } from './components/EdgePanel'
import { Filters } from './components/Filters'
import { applyCorrections, type Correction } from './lib/corrections'
import { estimateCost, formatUsd, MAX_PAGES, type CostEstimate } from './lib/cost'
import { pagesFromFile, runExtraction, toSourceChunks, type SourceChunk } from './lib/extract'
import type { Graph } from './lib/graph'
import { loadGraph, saveCorrections, saveGraph } from './lib/persist'
import { ENTITY_TYPES, type EntityType } from './lib/validate'
import { DEMO_DOC_NAME, DEMO_GRAPH, demoChunkPages } from './demo'

type Stage = 'idle' | 'estimating' | 'extracting' | 'ready'

const ALL_TYPES = new Set<EntityType>(ENTITY_TYPES)

export default function App() {
  const [baseGraph, setBaseGraph] = useState<Graph>(DEMO_GRAPH)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [docName, setDocName] = useState(DEMO_DOC_NAME)
  const [chunkPages, setChunkPages] = useState<Map<string, number>>(demoChunkPages)
  const [stage, setStage] = useState<Stage>('ready')
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 })
  const [pending, setPending] = useState<{ chunks: SourceChunk[]; estimate: CostEstimate } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [isDemo, setIsDemo] = useState(true)

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [isolatedId, setIsolatedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visibleTypes, setVisibleTypes] = useState<Set<EntityType>>(ALL_TYPES)

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
    loadGraph(wanted)
      .then((saved) => {
        if (cancelled || !saved) return
        setBaseGraph({ ...saved.graph })
        setCorrections(saved.corrections)
        setDocName(saved.docName)
        setChunkPages(new Map())
        setSlug(saved.slug)
        setIsDemo(false)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
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

  const onPickFile = useCallback(async (file: File) => {
    setError(null)
    setStage('estimating')
    try {
      const pages = await pagesFromFile(file)
      const chunks = toSourceChunks(pages)
      const estimate = estimateCost(
        chunks.map((c) => c.content),
        pages.length,
      )
      setDocName(file.name)
      setChunkPages(new Map(chunks.map((c) => [c.id, c.page])))
      setPending({ chunks, estimate })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage('ready')
    }
  }, [])

  const onRun = useCallback(async () => {
    if (!pending) return
    setStage('extracting')
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setCorrections([])
    setSlug(null)
    setIsDemo(false)
    try {
      const result = await runExtraction(pending.chunks, {
        // Nodes appear as chunks land. Thirty to ninety seconds of a graph
        // assembling itself is good theatre and honest progress at once.
        onProgress: (p) => {
          setProgress({ done: p.done, total: p.total, failed: p.failed })
          setBaseGraph(p.graph)
        },
      })
      setBaseGraph(result.graph)
      setPending(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStage('ready')
    }
  }, [pending])

  const pushCorrection = useCallback(
    (correction: Correction) => {
      setCorrections((current) => {
        const next = [...current, correction]
        if (slug) void saveCorrections(slug, next).catch(() => undefined)
        return next
      })
    },
    [slug],
  )

  const onShare = useCallback(async () => {
    setError(null)
    try {
      const created = await saveGraph(docName, baseGraph, corrections)
      setSlug(created)
      const url = new URL(window.location.href)
      url.searchParams.set('g', created)
      window.history.replaceState(null, '', url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [baseGraph, corrections, docName])

  return (
    <div className="app">
      <header className="app-head">
        <div>
          <h1>GraphRead</h1>
          <p className="doc-name">
            {docName}
            {isDemo && <span className="badge">demo</span>}
          </p>
        </div>
        <div className="head-actions">
          <label className="file-button">
            Open a document
            <input
              type="file"
              accept="application/pdf,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void onPickFile(file)
              }}
            />
          </label>
          {!isDemo && stage === 'ready' && (
            <button type="button" onClick={() => void onShare()}>
              {slug ? 'Link copied to the address bar' : 'Create a permalink'}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {pending && stage !== 'extracting' && (
        <div className="estimate" role="dialog" aria-label="Cost estimate">
          <p>
            {pending.estimate.pages} pages · {pending.estimate.chunks} passages · about{' '}
            <strong>{formatUsd(pending.estimate.usd)}</strong> of extraction.
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
        <p className="progress" role="status">
          Reading passage {progress.done} of {progress.total}
          {progress.failed > 0 && ` · ${progress.failed} failed`}
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
