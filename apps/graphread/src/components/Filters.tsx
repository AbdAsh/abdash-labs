import type { Graph } from '../lib/graph'
import { ENTITY_TYPES, type EntityType } from '../lib/validate'
import { TYPE_COLORS, TYPE_LABELS } from './types'

export interface FiltersProps {
  graph: Graph
  query: string
  visibleTypes: Set<EntityType>
  onQueryChange: (q: string) => void
  onToggleType: (t: EntityType) => void
}

export function Filters({
  graph,
  query,
  visibleTypes,
  onQueryChange,
  onToggleType,
}: FiltersProps) {
  const counts = new Map<EntityType, number>()
  for (const node of graph.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1)

  const { droppedRelations, keptRelations, chunks } = graph.stats

  return (
    <div className="filters">
      <input
        type="search"
        className="search"
        placeholder="Search entities…"
        value={query}
        aria-label="Search entities"
        onChange={(e) => onQueryChange(e.target.value)}
      />

      <div className="chips" role="group" aria-label="Filter by entity type">
        {ENTITY_TYPES.filter((t) => (counts.get(t) ?? 0) > 0).map((type) => {
          const on = visibleTypes.has(type)
          return (
            <button
              key={type}
              type="button"
              className={`chip${on ? ' chip-on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggleType(type)}
            >
              <span className="type-dot" style={{ background: TYPE_COLORS[type] }} />
              {TYPE_LABELS[type]}
              <span className="chip-count">{counts.get(type)}</span>
            </button>
          )
        })}
      </div>

      {/* The drop count is shown whether or not it is flattering. A graph that
          silently discards a third of what the model claimed is telling you
          something about the model, and hiding it would defeat the gate. */}
      <p className="stats" role="status">
        {graph.nodes.length} entities · {graph.edges.length} relations from {keptRelations}{' '}
        assertions across {chunks} passages ·{' '}
        <strong className={droppedRelations > 0 ? 'stat-dropped' : undefined}>
          {droppedRelations} dropped
        </strong>{' '}
        for an unverifiable quote
      </p>
    </div>
  )
}
