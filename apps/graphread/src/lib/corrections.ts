/**
 * Manual merge and split corrections.
 *
 * Automatic resolution will get some entities wrong. Rather than pretend
 * otherwise, the hardest failure mode is turned into a feature: drag one node
 * onto another to merge, or pull an alias out of a node to split. Corrections
 * are stored alongside the graph and replayed on load, so a permalink reopens
 * exactly what its author saw.
 *
 * Two properties make replay safe:
 *
 *   Order-independence — the corrections are canonically sorted before they
 *   are applied, so the stored array's order never changes the outcome.
 *
 *   Idempotence — applying a list to its own output is a no-op. That needs one
 *   rule: a merge may not re-absorb a node that a split in the same list
 *   produces. Contradictory instructions resolve to "the separation stands".
 */

import { mergeNodes, normalizeName, type ResolvedNode } from './resolve'
import { normalizeQuote } from './validate'
import type { Evidence, Graph, GraphEdge } from './graph'

export type Correction =
  | { kind: 'merge'; ids: string[] }
  | { kind: 'split'; id: string; alias: string }

const isMerge = (c: unknown): c is { kind: 'merge'; ids: string[] } =>
  !!c && (c as Correction).kind === 'merge' && Array.isArray((c as { ids: unknown }).ids)

const isSplit = (c: unknown): c is { kind: 'split'; id: string; alias: string } =>
  !!c &&
  (c as Correction).kind === 'split' &&
  typeof (c as { id: unknown }).id === 'string' &&
  typeof (c as { alias: unknown }).alias === 'string'

/**
 * Whole-name containment, case-insensitive and whitespace-tolerant. Used to
 * decide which evidence follows a split, so "Chen" must not match inside
 * "Chenille" — but "Chen founded…" must match.
 */
function quoteNames(quote: string, name: string): boolean {
  const haystack = normalizeName(normalizeQuote(quote))
  const needle = normalizeName(name)
  if (!needle) return false
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? ' ' : haystack[at - 1]!
    const afterIndex = at + needle.length
    const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex]!
    if (before === ' ' && after === ' ') return true
  }
  return false
}

function dedupeEvidence(items: Evidence[]): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const e of items) {
    const key = `${e.chunkId} ${e.quote}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

const sortEdges = (edges: GraphEdge[]): GraphEdge[] =>
  edges.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))

const sortNodes = (nodes: ResolvedNode[]): ResolvedNode[] =>
  nodes.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))

/**
 * Rebuilds the edge list after node ids have been remapped: self-loops vanish,
 * and edges that become parallel fuse into one with summed weight and unioned
 * evidence.
 */
function rewireEdges(edges: GraphEdge[], remap: (id: string) => string): GraphEdge[] {
  const byId = new Map<string, GraphEdge>()
  for (const edge of edges) {
    const source = remap(edge.source)
    const target = remap(edge.target)
    if (source === target) continue

    const id = `${source}|${edge.relation}|${target}`
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { ...edge, id, source, target, evidence: dedupeEvidence(edge.evidence) })
      continue
    }
    existing.weight += edge.weight
    existing.evidence = dedupeEvidence([...existing.evidence, ...edge.evidence])
  }
  return sortEdges([...byId.values()])
}

function applyMerges(graph: Graph, groups: string[][]): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const remap = new Map<string, string>()
  const absorbed = new Set<string>()
  const nodes = [...graph.nodes]

  for (const group of groups) {
    const members = group
      .map((id) => byId.get(remap.get(id) ?? id))
      .filter((n): n is ResolvedNode => !!n)
    const unique = [...new Map(members.map((m) => [m.id, m])).values()]
    if (unique.length < 2) continue

    const merged = mergeNodes(unique)
    for (const m of unique) {
      if (m.id !== merged.id) absorbed.add(m.id)
      remap.set(m.id, merged.id)
      // A later group naming an already-absorbed id must land on the survivor.
      for (const [from, to] of remap) if (to === m.id) remap.set(from, merged.id)
    }
    byId.set(merged.id, merged)
    const at = nodes.findIndex((n) => n.id === merged.id)
    if (at >= 0) nodes[at] = merged
    else nodes.push(merged)
  }

  if (remap.size === 0) return graph

  const resolveId = (id: string): string => {
    let current = id
    for (let hops = 0; hops < 64 && remap.has(current) && remap.get(current) !== current; hops++) {
      current = remap.get(current)!
    }
    return current
  }

  return {
    nodes: sortNodes(nodes.filter((n) => !absorbed.has(n.id))),
    edges: rewireEdges(graph.edges, resolveId),
    stats: graph.stats,
  }
}

/** `${type}:${normalized-alias}`, matching the id scheme the resolver uses. */
function splitProductId(node: ResolvedNode, alias: string, taken: Set<string>): string {
  const base = `${node.type}:${normalizeName(alias).replace(/ /g, '-')}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}~${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function applySplit(graph: Graph, id: string, alias: string): Graph {
  const source = graph.nodes.find((n) => n.id === id)
  if (!source) return graph

  const wanted = normalizeName(alias)
  const surface = source.aliases.find((a) => normalizeName(a) === wanted)
  // Splitting a node's only alias would leave an empty node behind.
  if (!surface || source.aliases.length < 2) return graph

  const retainedAliases = source.aliases.filter((a) => a !== surface)
  const taken = new Set(graph.nodes.map((n) => n.id))
  const newId = splitProductId(source, surface, taken)

  const retainedName = retainedAliases.reduce((a, b) => (b.length > a.length ? b : a))

  // Evidence follows the alias only when it names the alias and does *not*
  // name what stays behind. "Dr. Sarah Chen founded Helix Labs" contains the
  // string "Chen", but it is plainly about Sarah Chen, so it does not move.
  const belongsToSplit = (e: Evidence) =>
    quoteNames(e.quote, surface) && !retainedAliases.some((a) => quoteNames(e.quote, a))

  const edges: GraphEdge[] = []
  const movedChunks: string[] = []
  let movedWeight = 0

  for (const edge of graph.edges) {
    const touches = edge.source === id || edge.target === id
    if (!touches) {
      edges.push({ ...edge })
      continue
    }

    const moved = edge.evidence.filter(belongsToSplit)
    if (moved.length === 0) {
      edges.push({ ...edge })
      continue
    }

    const stayed = edge.evidence.filter((e) => !belongsToSplit(e))
    // Weight is apportioned by evidence share; neither side may drop below one.
    const newWeight =
      stayed.length === 0
        ? edge.weight
        : Math.max(1, Math.round((edge.weight * moved.length) / edge.evidence.length))

    const newSource = edge.source === id ? newId : edge.source
    const newTarget = edge.target === id ? newId : edge.target
    if (newSource !== newTarget) {
      edges.push({
        id: `${newSource}|${edge.relation}|${newTarget}`,
        source: newSource,
        target: newTarget,
        relation: edge.relation,
        weight: newWeight,
        evidence: moved,
      })
      movedWeight += newWeight
      for (const e of moved) if (!movedChunks.includes(e.chunkId)) movedChunks.push(e.chunkId)
    }

    if (stayed.length > 0) {
      edges.push({
        ...edge,
        weight: Math.max(1, edge.weight - newWeight),
        evidence: stayed,
      })
    }
  }

  // Mentions cannot be recovered per alias, so the two nodes share them: the
  // extracted node takes one per unit of edge weight that followed it, at
  // least one, and the original keeps the rest without dropping below one.
  const extractedMentions = Math.min(Math.max(1, movedWeight), Math.max(1, source.mentions - 1))

  const extracted: ResolvedNode = {
    id: newId,
    name: surface,
    type: source.type,
    aliases: [surface],
    description: source.description,
    mentions: extractedMentions,
    chunkIds: movedChunks.length > 0 ? movedChunks : [...source.chunkIds],
  }

  const retained: ResolvedNode = {
    ...source,
    name: retainedName,
    aliases: [...retainedAliases].sort(),
    mentions: Math.max(1, source.mentions - extractedMentions),
  }

  return {
    nodes: sortNodes([...graph.nodes.filter((n) => n.id !== id), retained, extracted]),
    edges: rewireEdges(edges, (x) => x),
    stats: graph.stats,
  }
}

/**
 * Replays a correction list onto a graph. Pure — the input graph is never
 * mutated. Splits are computed before merges so a merge cannot re-absorb what
 * a split in the same list separates, then merges are applied first so a split
 * operates on the fused node the user was actually looking at.
 */
export function applyCorrections(graph: Graph, corrections: Correction[]): Graph {
  const list = Array.isArray(corrections) ? corrections : []

  const merges = list
    .filter(isMerge)
    .map((c) => c.ids.filter((id) => typeof id === 'string').sort())
    .filter((ids) => ids.length > 1)
    .sort((a, b) => a.join().localeCompare(b.join()))

  const splits = list
    .filter(isSplit)
    .map((c) => ({ id: c.id, alias: c.alias }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.alias.localeCompare(b.alias))

  if (merges.length === 0 && splits.length === 0) return graph

  // Ids the splits will create. A merge naming one of them is dropped, which
  // is what keeps merge-then-split stable across reloads.
  const pinned = new Set<string>()
  for (const s of splits) {
    const target = graph.nodes.find((n) => n.id === s.id)
    if (target) pinned.add(`${target.type}:${normalizeName(s.alias).replace(/ /g, '-')}`)
  }

  const admissible = merges
    .map((ids) => ids.filter((id) => !pinned.has(id)))
    .filter((ids) => ids.length > 1)

  const cloned: Graph = {
    nodes: graph.nodes.map((n) => ({ ...n, aliases: [...n.aliases], chunkIds: [...n.chunkIds] })),
    edges: graph.edges.map((e) => ({ ...e, evidence: e.evidence.map((x) => ({ ...x })) })),
    stats: { ...graph.stats },
  }

  let out = applyMerges(cloned, admissible)
  for (const s of splits) out = applySplit(out, s.id, s.alias)
  return out
}
