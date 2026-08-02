/**
 * Permalinks.
 *
 * A saved graph is one row: nodes, edges, stats and corrections together, so
 * opening a link is a single fetch. Corrections are stored *beside* the graph
 * rather than baked into it, which is what lets a shared link reopen with the
 * author's manual merges applied without destroying the automatic result
 * underneath.
 *
 * Saving is opt-in and public, but "public" is scoped to one slug at a time:
 * reads go through the SECURITY DEFINER accessor `graphread.graph_by_slug`
 * rather than a blanket select policy, so a permalink reveals its own graph and
 * nothing about the existence of anyone else's. The local-only path never
 * touches this module.
 */

import { supabase } from '@labs/platform'
import { applyCorrections, type Correction } from './corrections'
import type { Graph } from './graph'
import type { ResolvedNode } from './resolve'
import type { GraphEdge, GraphStats } from './graph'

export interface SavedGraph {
  slug: string
  docName: string
  graph: Graph
  corrections: Correction[]
  createdAt: string
}

const SCHEMA = () => supabase.schema('graphread')
const TABLE = () => SCHEMA().from('graphs')

/** Row shape returned by the `graph_by_slug` accessor. No `owner_id`, by design. */
interface GraphRow {
  slug: string
  doc_name: string
  nodes: unknown
  edges: unknown
  corrections: unknown
  stats: unknown
  created_at: string
}

/** `annual-report-2026-k3f9` — readable enough to recognise in a browser history. */
export function slugFor(docName: string): string {
  const stem = docName
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${stem || 'graph'}-${suffix}`
}

export async function saveGraph(
  docName: string,
  graph: Graph,
  corrections: Correction[] = [],
): Promise<string> {
  const slug = slugFor(docName)
  const { error } = await TABLE().insert({
    slug,
    doc_name: docName,
    nodes: graph.nodes,
    edges: graph.edges,
    stats: graph.stats,
    corrections,
  })
  if (error) throw error
  return slug
}

/**
 * Loads a permalink. The stored corrections are returned alongside the raw
 * graph and applied on top, so the caller sees exactly what the author saw and
 * can still inspect or undo an individual correction.
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

  const raw: Graph = {
    nodes: (data.nodes ?? []) as ResolvedNode[],
    edges: (data.edges ?? []) as GraphEdge[],
    stats: (data.stats ?? {
      chunks: 0,
      keptRelations: 0,
      droppedRelations: 0,
      unresolvedRelations: 0,
    }) as GraphStats,
  }
  const corrections = (data.corrections ?? []) as Correction[]

  return {
    slug: data.slug,
    docName: data.doc_name,
    graph: applyCorrections(raw, corrections),
    corrections,
    createdAt: data.created_at,
  }
}

/** Persists the correction list. Owner-only, enforced by RLS rather than here. */
export async function saveCorrections(slug: string, corrections: Correction[]): Promise<void> {
  const { error } = await TABLE().update({ corrections }).eq('slug', slug)
  if (error) throw error
}

export async function listMyGraphs(): Promise<{ slug: string; docName: string }[]> {
  const { data, error } = await TABLE()
    .select('slug, doc_name')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []).map((r) => ({ slug: r.slug, docName: r.doc_name }))
}
