/**
 * Permalinks.
 *
 * A saved graph is one row: nodes, edges, stats, the chunk-to-page map and
 * corrections together, so opening a link is a single fetch. Corrections are
 * stored *beside* the graph rather than baked into it, which is what lets a
 * shared link reopen with the author's manual merges applied without destroying
 * the automatic result underneath — and this module returns the raw graph and
 * the correction list separately for exactly that reason. Applying them is the
 * caller's job, once.
 *
 * Saving is opt-in and public, but "public" is scoped to one slug at a time:
 * reads go through the SECURITY DEFINER accessor `graphread.graph_by_slug`
 * rather than a blanket select policy, so a permalink reveals its own graph and
 * nothing about the existence of anyone else's. Writes stay on the table under
 * the owner policy. The local-only path never touches this module.
 */

import { supabase } from '@labs/platform'
import type { Correction } from './corrections'
import type { Graph, GraphEdge, GraphStats } from './graph'
import type { ResolvedNode } from './resolve'

export interface SavedGraph {
  slug: string
  docName: string
  /** As stored: automatic resolution only, corrections not yet applied. */
  graph: Graph
  corrections: Correction[]
  chunkPages: Map<string, number>
  /** Whether the current session may write to this row. See `graph_by_slug`. */
  isOwner: boolean
  createdAt: string
}

const SCHEMA = () => supabase.schema('graphread')
const TABLE = () => SCHEMA().from('graphs')

/**
 * Postgres will take a far larger row than this, but the whole project's budget
 * is 50 MB and one runaway graph should not be able to eat a meaningful slice
 * of it. A graph this size is also past the point of being explorable.
 */
export const MAX_GRAPH_BYTES = 2_000_000

/** Row shape returned by the `graph_by_slug` accessor. No `owner_id`, by design. */
interface GraphRow {
  slug: string
  doc_name: string
  nodes: unknown
  edges: unknown
  corrections: unknown
  chunk_pages: unknown
  stats: unknown
  created_at: string
  is_owner: boolean | null
}

const EMPTY_STATS: GraphStats = {
  chunks: 0,
  keptRelations: 0,
  droppedRelations: 0,
  unresolvedRelations: 0,
}

/** `annual-report-2026-k3f9` — readable enough to recognise in a browser history. */
export function slugFor(docName: string): string {
  const stem = docName
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

  // `crypto`, not `Math.random`: the slug column is unique, so a collision is a
  // failed save rather than a mix-up, but a failed save is still a bad minute.
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6)
  return `${stem || 'graph'}-${suffix}`
}

const pagesToJson = (pages: Map<string, number>): Record<string, number> =>
  Object.fromEntries(pages)

function pagesFromJson(value: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!value || typeof value !== 'object') return out
  for (const [chunkId, page] of Object.entries(value as Record<string, unknown>)) {
    if (typeof page === 'number' && Number.isFinite(page)) out.set(chunkId, page)
  }
  return out
}

export async function saveGraph(
  docName: string,
  graph: Graph,
  corrections: Correction[] = [],
  chunkPages: Map<string, number> = new Map(),
): Promise<string> {
  const row = {
    slug: slugFor(docName),
    doc_name: docName,
    nodes: graph.nodes,
    edges: graph.edges,
    stats: graph.stats,
    chunk_pages: pagesToJson(chunkPages),
    corrections,
  }

  const bytes = JSON.stringify(row).length
  if (bytes > MAX_GRAPH_BYTES) {
    throw new Error(
      `This graph is ${Math.round(bytes / 1000)} kB, over the ${Math.round(
        MAX_GRAPH_BYTES / 1000,
      )} kB permalink limit. Filter it down or extract a shorter document.`,
    )
  }

  const { error } = await TABLE().insert(row)
  if (error) throw error
  return row.slug
}

/**
 * Loads a permalink, or `null` when the slug names nothing — a dead link is an
 * ordinary outcome, not an exception, and the caller has to be able to say so
 * rather than quietly showing whatever was already on screen.
 */
export async function loadGraph(slug: string): Promise<SavedGraph | null> {
  // Goes through a SECURITY DEFINER accessor rather than a filtered select.
  // A `for select using (true)` policy would work, but RLS cannot see that we
  // filtered by slug — it would grant the whole table, letting anyone enumerate
  // every document every user has graphed. owner_id is never returned.
  const { data: rows, error } = await SCHEMA().rpc('graph_by_slug', { p_slug: slug })
  if (error) throw error

  const data = (rows as GraphRow[] | null)?.[0]
  if (!data) return null

  return {
    slug: data.slug,
    docName: data.doc_name,
    graph: {
      nodes: (data.nodes ?? []) as ResolvedNode[],
      edges: (data.edges ?? []) as GraphEdge[],
      stats: (data.stats ?? EMPTY_STATS) as GraphStats,
    },
    corrections: (data.corrections ?? []) as Correction[],
    chunkPages: pagesFromJson(data.chunk_pages),
    isOwner: data.is_owner === true,
    createdAt: data.created_at,
  }
}

/**
 * Persists the correction list. Owner-only, enforced by RLS: a non-owner's
 * update matches zero rows and reports no error, which is correct for the
 * database and useless for the user — so the caller checks `isOwner` first and
 * never gets here.
 */
export async function saveCorrections(slug: string, corrections: Correction[]): Promise<void> {
  const { error } = await TABLE().update({ corrections }).eq('slug', slug)
  if (error) throw error
}
