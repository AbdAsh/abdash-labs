import { useMemo } from 'react'
import type { Graph, GraphEdge } from '../lib/graph'
import type { ResolvedNode } from '../lib/resolve'
import { TYPE_COLORS } from './types'

/**
 * The provenance panel — the reason to trust the graph at all.
 *
 * Every relation listed here shows the passage that produced it, because a
 * graph you cannot check is a graph you have to take on faith, and taking a
 * language model on faith is the failure this whole project is arranged
 * against.
 */

export interface NodePanelProps {
  graph: Graph
  node: ResolvedNode
  chunkPages?: Map<string, number>
  onSelectNode: (id: string) => void
  onIsolate: (id: string) => void
  onClose?: () => void
  onSplit?: (id: string, alias: string) => void
}

interface Incidence {
  edge: GraphEdge
  otherId: string
  direction: 'out' | 'in'
}

export function NodePanel({
  graph,
  node,
  chunkPages,
  onSelectNode,
  onIsolate,
  onClose,
  onSplit,
}: NodePanelProps) {
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])

  const grouped = useMemo(() => {
    const groups = new Map<string, Incidence[]>()
    for (const edge of graph.edges) {
      let incidence: Incidence | null = null
      if (edge.source === node.id) incidence = { edge, otherId: edge.target, direction: 'out' }
      else if (edge.target === node.id) incidence = { edge, otherId: edge.source, direction: 'in' }
      if (!incidence) continue
      const list = groups.get(edge.relation)
      if (list) list.push(incidence)
      else groups.set(edge.relation, [incidence])
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [graph.edges, node.id])

  const where = (chunkId: string) => {
    const page = chunkPages?.get(chunkId)
    return page ? `p.${page}` : chunkId
  }

  return (
    <aside className="panel" aria-label={`Details for ${node.name}`}>
      <header className="panel-head">
        <span className="type-dot" style={{ background: TYPE_COLORS[node.type] }} />
        <div>
          <h2>{node.name}</h2>
          <p className="panel-sub">
            {node.type} · mentioned {node.mentions} {node.mentions === 1 ? 'time' : 'times'} in{' '}
            {node.chunkIds.length === 0 ? (
              'no recorded passage'
            ) : (
              <>
                {node.chunkIds.length === 1 ? 'passage ' : 'passages '}
                {node.chunkIds.map(where).join(', ')}
              </>
            )}
          </p>
        </div>
        {onClose && (
          <button type="button" className="panel-close" aria-label="Close panel" onClick={onClose}>
            ×
          </button>
        )}
      </header>

      {node.description && (
        <p className="panel-desc">
          {node.description}
          {/* Descriptions are the model's own words about the passage, not a
              quote from it, and they sit next to quotes that were verified.
              Saying which is which is the difference between a citation and a
              claim wearing a citation's clothes. */}
          <span className="panel-unverified"> — the model's summary, not a quotation</span>
        </p>
      )}

      {node.aliases.length > 1 && (
        <section className="panel-section">
          <h3>Also written as</h3>
          <ul className="alias-list">
            {node.aliases.map((alias) => (
              <li key={alias}>
                <span>{alias}</span>
                {onSplit && node.aliases.length > 1 && (
                  <button
                    type="button"
                    className="link-button"
                    title={`Separate "${alias}" into its own node`}
                    onClick={() => onSplit(node.id, alias)}
                  >
                    split
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="panel-hint">
            These were merged into one entity. If that was wrong, split the alias back out.
          </p>
        </section>
      )}

      <section className="panel-section">
        <h3>Relations</h3>
        {grouped.length === 0 && (
          <p className="panel-hint">
            Nothing connects this entity. Either the document never related it to another entity,
            or the relations that did could not be quoted and were dropped.
          </p>
        )}
        {grouped.map(([relation, items]) => (
          <div key={relation} className="relation-group">
            <h4>{relation}</h4>
            {items.map(({ edge, otherId, direction }) => {
              const other = byId.get(otherId)
              return (
                <div key={edge.id} className="relation-row">
                  <button
                    type="button"
                    className="entity-link"
                    onClick={() => onSelectNode(otherId)}
                  >
                    {direction === 'in' && <span className="direction">← </span>}
                    {other?.name ?? otherId}
                    {direction === 'out' && <span className="direction"> →</span>}
                  </button>
                  <ul className="quotes">
                    {edge.evidence.map((e) => (
                      <li key={`${e.chunkId}-${e.quote}`}>
                        <q>{e.quote}</q> <span className="cite">{where(e.chunkId)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        ))}
      </section>

      <footer className="panel-foot">
        <button type="button" onClick={() => onIsolate(node.id)}>
          Isolate neighbourhood
        </button>
      </footer>
    </aside>
  )
}
