/**
 * Cross-chunk entity resolution, in two passes.
 *
 * Pass 1 is deterministic and free: normalise the surface form and group on
 * (normalized name, type). Pass 2 is cheap and probabilistic: embed
 * `name: description` through the shared `raglab-embed` proxy and merge
 * near-duplicates.
 *
 * THE TYPE GATE runs through both. Entities are only ever compared against
 * entities of the same type. "Helix Labs" the organization and "Helix" the
 * artifact will read as near-identical to any embedding model, and collapsing
 * a company into its product is the most embarrassing failure this tool has.
 * So the buckets are per type and nothing crosses them — not at 0.9, not at
 * 1.0. Similarity is never allowed to overrule a type disagreement.
 */

import { ENTITY_TYPES, normalizeName, type EntityType, type RawEntity } from './validate'

// Re-exported because the resolver is where callers expect name normalisation
// to live, even though the gate owns the rule.
export { normalizeName }

export interface ResolvedNode {
  id: string
  name: string
  type: EntityType
  aliases: string[]
  description: string
  mentions: number
  chunkIds: string[]
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>

/**
 * High by design. Two unrelated person names already sit around 0.75 with
 * `text-embedding-3-small`, so a permissive threshold would fuse a document's
 * whole cast into one blob. Over-splitting is recoverable by the merge
 * correction; over-merging destroys information silently.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.86

/** raglab-embed caps a request at 200 texts. */
const EMBED_BATCH = 200

/** Stable across runs, so a permalink's node ids survive re-extraction. */
function nodeId(type: EntityType, normalized: string): string {
  return `${type}:${normalized.replace(/ /g, '-')}`
}

const isEntityType = (t: unknown): t is EntityType =>
  (ENTITY_TYPES as readonly unknown[]).includes(t)

interface Accumulator {
  id: string
  type: EntityType
  surfaces: Map<string, number>
  description: string
  mentions: number
  chunkIds: string[]
}

/**
 * Picks the display name: the surface form the document uses most often, then
 * the longest (the fuller form carries more information), then alphabetical so
 * the result never depends on iteration order.
 */
function canonicalSurface(surfaces: Map<string, number>): string {
  let best = ''
  let bestCount = -1
  for (const [surface, count] of surfaces) {
    if (
      count > bestCount ||
      (count === bestCount &&
        (surface.length > best.length || (surface.length === best.length && surface < best)))
    ) {
      best = surface
      bestCount = count
    }
  }
  return best
}

function finalize(acc: Accumulator): ResolvedNode {
  return {
    id: acc.id,
    name: canonicalSurface(acc.surfaces),
    type: acc.type,
    aliases: [...acc.surfaces.keys()].sort(),
    description: acc.description,
    mentions: acc.mentions,
    chunkIds: acc.chunkIds,
  }
}

/**
 * Pass 1. Groups on (normalized name, type). Deliberately conservative: it
 * will not guess that "Chen" is "Sarah Chen", because a surname alone is
 * genuinely ambiguous and that call belongs to the embedding pass, where the
 * description gives it something to go on.
 */
export function lexicalPass(entities: { entity: RawEntity; chunkId: string }[]): ResolvedNode[] {
  const groups = new Map<string, Accumulator>()

  for (const item of entities ?? []) {
    const entity = item?.entity
    if (!entity || !isEntityType(entity.type)) continue

    const surface = typeof entity.name === 'string' ? entity.name.trim() : ''
    if (!surface) continue

    const normalized = normalizeName(surface)
    if (!normalized) continue

    const id = nodeId(entity.type, normalized)
    const description = typeof entity.description === 'string' ? entity.description.trim() : ''
    const chunkId = typeof item.chunkId === 'string' ? item.chunkId : ''

    let acc = groups.get(id)
    if (!acc) {
      acc = {
        id,
        type: entity.type,
        surfaces: new Map(),
        description: '',
        mentions: 0,
        chunkIds: [],
      }
      groups.set(id, acc)
    }

    acc.mentions += 1
    acc.surfaces.set(surface, (acc.surfaces.get(surface) ?? 0) + 1)
    if (description.length > acc.description.length) acc.description = description
    if (chunkId && !acc.chunkIds.includes(chunkId)) acc.chunkIds.push(chunkId)
  }

  return [...groups.values()].map(finalize)
}

class UnionFind {
  private parent = new Map<string, string>()

  constructor(ids: string[]) {
    for (const id of ids) this.parent.set(id, id)
  }

  find(id: string): string {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression, so a long alias chain stays O(1) on later lookups.
    let walk = id
    while (this.parent.get(walk) !== root) {
      const next = this.parent.get(walk)!
      this.parent.set(walk, root)
      walk = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    // Smaller id becomes the root, purely so the outcome is order-independent.
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const embedText = (n: ResolvedNode): string =>
  n.description ? `${n.name}: ${n.description}` : n.name

async function embedInBatches(embed: EmbedFn, texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    out.push(...(await embed(texts.slice(i, i + EMBED_BATCH))))
  }
  return out
}

/** Loaded lazily so the pure resolution logic stays testable without Supabase. */
async function defaultEmbedder(): Promise<EmbedFn> {
  const mod = await import('./embed')
  return mod.embedTexts
}

/**
 * Fuses several resolved nodes into one. Exported so the manual merge
 * correction uses the identical rules as automatic resolution — a user merge
 * and an embedding merge must not produce differently-shaped nodes.
 */
export function mergeNodes(members: ResolvedNode[]): ResolvedNode {
  const surfaces = new Map<string, number>()
  const chunkIds: string[] = []
  let description = ''
  let mentions = 0

  // Aliases carry no per-surface counts once a node is built, so weight each
  // member's own display name by that member's mention count — which is what
  // "the form the document uses most" means after a lexical merge.
  for (const m of members) {
    mentions += m.mentions
    for (const alias of m.aliases) {
      surfaces.set(alias, (surfaces.get(alias) ?? 0) + (alias === m.name ? m.mentions : 0))
    }
    for (const c of m.chunkIds) if (!chunkIds.includes(c)) chunkIds.push(c)
    if (m.description.length > description.length) description = m.description
  }

  const name = canonicalSurface(surfaces)
  const winner = members.find((m) => m.name === name) ?? members[0]!

  return {
    id: winner.id,
    name,
    type: winner.type,
    aliases: [...surfaces.keys()].sort(),
    description,
    mentions,
    chunkIds,
  }
}

/**
 * Pass 2. Embeds every node that shares its type with at least one other node,
 * then merges above `threshold` using union-find so alias chains resolve
 * transitively: if A matches B and B matches C, all three are one entity even
 * when A and C never clear the bar directly.
 *
 * Failure is non-fatal. A 503 from the embedding proxy returns the lexical
 * graph untouched — a slightly over-split graph is a far better outcome than
 * an error page, and the manual merge correction exists for exactly this.
 */
export async function embeddingPass(
  nodes: ResolvedNode[],
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
  embed?: EmbedFn,
): Promise<ResolvedNode[]> {
  if (nodes.length < 2) return nodes

  const buckets = new Map<EntityType, ResolvedNode[]>()
  for (const n of nodes) {
    const bucket = buckets.get(n.type)
    if (bucket) bucket.push(n)
    else buckets.set(n.type, [n])
  }

  // Only types with something to compare against are worth paying to embed.
  const comparable = [...buckets.values()].filter((b) => b.length > 1)
  if (comparable.length === 0) return nodes

  const subjects = comparable.flat()
  let vectors: number[][]
  try {
    const fn = embed ?? (await defaultEmbedder())
    vectors = await embedInBatches(fn, subjects.map(embedText))
  } catch {
    return nodes
  }
  if (vectors.length !== subjects.length) return nodes

  const vectorById = new Map<string, number[]>()
  subjects.forEach((n, i) => vectorById.set(n.id, vectors[i]!))

  const uf = new UnionFind(nodes.map((n) => n.id))
  for (const bucket of comparable) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = vectorById.get(bucket[i]!.id)
        const b = vectorById.get(bucket[j]!.id)
        if (!a || !b) continue
        if (cosine(a, b) >= threshold) uf.union(bucket[i]!.id, bucket[j]!.id)
      }
    }
  }

  const grouped = new Map<string, ResolvedNode[]>()
  for (const n of nodes) {
    const root = uf.find(n.id)
    const g = grouped.get(root)
    if (g) g.push(n)
    else grouped.set(root, [n])
  }

  return [...grouped.values()]
    .map(mergeNodes)
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
}
