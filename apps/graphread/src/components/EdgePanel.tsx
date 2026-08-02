import type { Graph, GraphEdge } from '../lib/graph'

export interface EdgePanelProps {
  graph: Graph
  edge: GraphEdge
  chunkPages?: Map<string, number>
  onSelectNode: (id: string) => void
}

/**
 * An edge's evidence. Every quote here was matched against its source passage
 * before the edge was drawn — that is the only reason the edge exists.
 */
export function EdgePanel({ graph, edge, chunkPages, onSelectNode }: EdgePanelProps) {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id
  const where = (chunkId: string) => {
    const page = chunkPages?.get(chunkId)
    return page ? `p.${page}` : chunkId
  }

  return (
    <aside className="panel" aria-label="Relation evidence">
      <header className="panel-head">
        <div>
          <h2 className="edge-title">
            <button type="button" className="entity-link" onClick={() => onSelectNode(edge.source)}>
              {name(edge.source)}
            </button>
            <em>{edge.relation}</em>
            <button type="button" className="entity-link" onClick={() => onSelectNode(edge.target)}>
              {name(edge.target)}
            </button>
          </h2>
          <p className="panel-sub">
            asserted {edge.weight} {edge.weight === 1 ? 'time' : 'times'}
          </p>
        </div>
      </header>

      <section className="panel-section">
        <h3>Source passages</h3>
        <ul className="quotes">
          {edge.evidence.map((e) => (
            <li key={`${e.chunkId}-${e.quote}`}>
              <q>{e.quote}</q> <span className="cite">{where(e.chunkId)}</span>
            </li>
          ))}
        </ul>
        <p className="panel-hint">
          Each quote was found verbatim in the passage it cites. Relations whose quote could not be
          found were dropped before this graph was drawn.
        </p>
      </section>
    </aside>
  )
}
