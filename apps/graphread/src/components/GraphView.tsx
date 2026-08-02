import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { degrees, neighbourhood, type Graph } from '../lib/graph'
import type { EntityType } from '../lib/validate'
import { TYPE_COLORS } from './types'

/**
 * The force-directed canvas.
 *
 * 2D rather than 3D on purpose — a 3D graph is prettier in a screenshot and
 * worse to read, because occlusion hides exactly the edges you are trying to
 * follow.
 *
 * react-force-graph mutates the objects it is handed: it writes x/y/vx/vy onto
 * nodes and swaps link `source`/`target` from ids to node references. So the
 * data passed in here is always a fresh shallow copy, never the application's
 * own graph.
 */

interface SimNode {
  id: string
  name: string
  type: EntityType
  degree: number
  x?: number
  y?: number
}

interface SimLink {
  id: string
  source: string | SimNode
  target: string | SimNode
  relation: string
  weight: number
}

export interface GraphViewProps {
  graph: Graph
  selectedNodeId: string | null
  selectedEdgeId: string | null
  visibleTypes: Set<EntityType>
  query: string
  isolatedId: string | null
  onSelectNode: (id: string | null) => void
  onSelectEdge: (id: string | null) => void
  onIsolate: (id: string | null) => void
  onMergeNodes?: (a: string, b: string) => void
}

const linkEnd = (end: string | SimNode): string => (typeof end === 'string' ? end : end.id)

/**
 * A merge only fires when the dragged node is visually sitting on top of its
 * target. A generous radius would turn every clumsy drag in a dense cluster
 * into an accidental merge, and an accidental merge silently destroys
 * information — the one failure this app is built to avoid.
 */
const MERGE_OVERLAP = 4

/** Two clicks inside this window on the same node isolate its neighbourhood. */
const DOUBLE_CLICK_MS = 320

export function GraphView({
  graph,
  selectedNodeId,
  selectedEdgeId,
  visibleTypes,
  query,
  isolatedId,
  onSelectNode,
  onSelectEdge,
  onIsolate,
  onMergeNodes,
}: GraphViewProps) {
  const wrapper = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    const el = wrapper.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({
        width: Math.max(240, entry.contentRect.width),
        height: Math.max(240, entry.contentRect.height),
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const visibleIds = useMemo(() => {
    const isolated = isolatedId ? neighbourhood(graph, isolatedId) : null
    const needle = query.trim().toLowerCase()
    const ids = new Set<string>()
    for (const node of graph.nodes) {
      if (!visibleTypes.has(node.type)) continue
      if (isolated && !isolated.has(node.id)) continue
      if (
        needle &&
        !node.name.toLowerCase().includes(needle) &&
        !node.aliases.some((a) => a.toLowerCase().includes(needle))
      ) {
        continue
      }
      ids.add(node.id)
    }
    return ids
  }, [graph, visibleTypes, query, isolatedId])

  // A fresh object graph every render the data changes — see the note above.
  const data = useMemo(() => {
    const degree = degrees(graph)
    const nodes: SimNode[] = graph.nodes
      .filter((n) => visibleIds.has(n.id))
      .map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        degree: degree.get(n.id) ?? 0,
      }))
    const links: SimLink[] = graph.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        relation: e.relation,
        weight: e.weight,
      }))
    return { nodes, links }
  }, [graph, visibleIds])

  const highlighted = useMemo(() => {
    const focus = hoveredId ?? selectedNodeId
    return focus ? neighbourhood(graph, focus) : null
  }, [graph, hoveredId, selectedNodeId])

  const radius = useCallback((n: SimNode) => 3 + Math.sqrt(n.degree) * 2.2, [])

  const drawNode = useCallback(
    (node: SimNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0
      const y = node.y ?? 0
      const r = radius(node)
      const dimmed = highlighted !== null && !highlighted.has(node.id)

      ctx.globalAlpha = dimmed ? 0.15 : 1
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fillStyle = TYPE_COLORS[node.type] ?? '#9aa3b0'
      ctx.fill()

      if (node.id === selectedNodeId) {
        ctx.lineWidth = 2 / scale
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
      }

      // Labels only once there is room for them; below that they are noise.
      if (scale > 1.1 || node.degree > 2) {
        const fontSize = Math.max(9, 12 / scale)
        ctx.font = `${fontSize}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = 'rgba(233, 237, 243, 0.92)'
        ctx.fillText(node.name, x, y + r + 2 / scale)
      }
      ctx.globalAlpha = 1
    },
    [highlighted, radius, selectedNodeId],
  )

  const drawNodeHitArea = useCallback(
    (node: SimNode, color: string, ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, radius(node) + 3, 0, 2 * Math.PI)
      ctx.fill()
    },
    [radius],
  )

  const linkColor = useCallback(
    (link: SimLink) => {
      if (link.id === selectedEdgeId) return 'rgba(255,255,255,0.9)'
      if (!highlighted) return 'rgba(150,163,184,0.35)'
      const on = highlighted.has(linkEnd(link.source)) && highlighted.has(linkEnd(link.target))
      return on ? 'rgba(203,213,225,0.75)' : 'rgba(150,163,184,0.07)'
    },
    [highlighted, selectedEdgeId],
  )

  const handleNodeDragEnd = useCallback(
    (dragged: SimNode) => {
      if (!onMergeNodes) return
      let nearest: SimNode | null = null
      let best = Infinity
      for (const other of data.nodes) {
        if (other.id === dragged.id) continue
        const dx = (other.x ?? 0) - (dragged.x ?? 0)
        const dy = (other.y ?? 0) - (dragged.y ?? 0)
        const distance = Math.hypot(dx, dy)
        // The two circles have to actually overlap on screen.
        if (distance < radius(dragged) + radius(other) - MERGE_OVERLAP && distance < best) {
          best = distance
          nearest = other
        }
      }
      // Dropping one node onto another is the merge gesture. It is deliberately
      // an explicit human act: automatic resolution will not merge across entity
      // types, and a person looking at both nodes may decide otherwise.
      if (nearest) onMergeNodes(dragged.id, nearest.id)
    },
    [data.nodes, onMergeNodes, radius],
  )

  const lastClick = useRef<{ id: string; at: number } | null>(null)

  const handleNodeClick = useCallback(
    (node: SimNode) => {
      const now = Date.now()
      const previous = lastClick.current
      lastClick.current = { id: node.id, at: now }

      if (previous && previous.id === node.id && now - previous.at < DOUBLE_CLICK_MS) {
        lastClick.current = null
        onIsolate(isolatedId === node.id ? null : node.id)
        return
      }
      onSelectEdge(null)
      onSelectNode(node.id)
    },
    [isolatedId, onIsolate, onSelectEdge, onSelectNode],
  )

  return (
    <div ref={wrapper} className="graph-canvas">
      <ForceGraph2D
        width={size.width}
        height={size.height}
        graphData={data}
        backgroundColor="transparent"
        nodeId="id"
        nodeLabel={(n: SimNode) => `${n.name} · ${n.type}`}
        linkLabel={(l: SimLink) => `${l.relation} (${l.weight})`}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={drawNodeHitArea}
        linkColor={linkColor}
        linkWidth={(l: SimLink) => (l.id === selectedEdgeId ? 2.5 : 0.6 + Math.log2(l.weight + 1))}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={0.92}
        cooldownTicks={120}
        d3VelocityDecay={0.3}
        onNodeHover={(n: SimNode | null) => setHoveredId(n?.id ?? null)}
        onNodeClick={handleNodeClick}
        onNodeRightClick={(n: SimNode) => onIsolate(isolatedId === n.id ? null : n.id)}
        onLinkClick={(l: SimLink) => {
          onSelectNode(null)
          onSelectEdge(l.id)
        }}
        onBackgroundClick={() => {
          onSelectNode(null)
          onSelectEdge(null)
          onIsolate(null)
        }}
        onNodeDragEnd={handleNodeDragEnd}
      />
      {isolatedId && (
        <button type="button" className="isolate-exit" onClick={() => onIsolate(null)}>
          Showing one neighbourhood — show all
        </button>
      )}
    </div>
  )
}
