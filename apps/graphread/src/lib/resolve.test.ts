import { describe, it, expect } from 'vitest'
import type { EntityType, RawEntity } from './validate'
import { embeddingPass, lexicalPass, type EmbedFn, type ResolvedNode } from './resolve'

const e = (name: string, type: EntityType, description = '', chunkId = 'c1') => ({
  entity: { name, type, description } satisfies RawEntity,
  chunkId,
})

/** Unit vector at `deg`, so cosine similarity is just cos(angle between). */
const at = (deg: number): number[] => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

/** Fake embedder keyed by node name. Records every text it was asked for. */
function fakeEmbedder(byName: Record<string, number[]>) {
  const seen: string[] = []
  const fn: EmbedFn = async (texts) => {
    seen.push(...texts)
    return texts.map((t) => {
      const name = t.split(': ')[0]!
      const v = byName[name]
      if (!v) throw new Error(`no fake vector for ${JSON.stringify(name)}`)
      return v
    })
  }
  return { fn, seen }
}

const names = (nodes: ResolvedNode[]) => nodes.map((n) => n.name).sort()

// `normalizeName` is exercised in validate.test.ts, where the function lives.

describe('lexicalPass', () => {
  it('merges case and honorific variants', () => {
    const nodes = lexicalPass([
      e('Dr. Sarah Chen', 'person'),
      e('sarah chen', 'person'),
      e('Sarah Chen', 'person'),
    ])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.aliases.sort()).toContain('Dr. Sarah Chen')
    expect(nodes[0]!.mentions).toBe(3)
  })

  it('refuses to merge the same name with different types', () => {
    const nodes = lexicalPass([e('Orbit', 'organization'), e('Orbit', 'artifact')])
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.type).sort()).toEqual(['artifact', 'organization'])
  })

  it('does not merge a surname into a full name lexically', () => {
    // "Chen" alone is ambiguous; that merge is the embedding pass's job, gated by type.
    expect(lexicalPass([e('Sarah Chen', 'person'), e('Chen', 'person')])).toHaveLength(2)
  })

  it('records every distinct surface form as an alias', () => {
    const [node] = lexicalPass([e('Dr. Sarah Chen', 'person'), e('sarah chen', 'person')])
    expect(node!.aliases.sort()).toEqual(['Dr. Sarah Chen', 'sarah chen'])
  })

  it('unions chunk ids without duplicating them', () => {
    const [node] = lexicalPass([
      e('Sarah Chen', 'person', '', 'c1'),
      e('sarah chen', 'person', '', 'c2'),
      e('SARAH CHEN', 'person', '', 'c1'),
    ])
    expect(node!.chunkIds).toEqual(['c1', 'c2'])
    expect(node!.mentions).toBe(3)
  })

  it('keeps the most informative description', () => {
    const [node] = lexicalPass([
      e('Sarah Chen', 'person', 'A founder.'),
      e('sarah chen', 'person', 'A biochemist who founded Helix Labs in 2019.'),
    ])
    expect(node!.description).toBe('A biochemist who founded Helix Labs in 2019.')
  })

  it('gives every node a stable id derived from its normalized name and type', () => {
    const a = lexicalPass([e('Dr. Sarah Chen', 'person')])
    const b = lexicalPass([e('sarah  chen', 'person')])
    expect(a[0]!.id).toBe(b[0]!.id)
    expect(lexicalPass([e('Orbit', 'organization')])[0]!.id).not.toBe(
      lexicalPass([e('Orbit', 'artifact')])[0]!.id,
    )
  })

  it('drops entities with a blank name or an unknown type', () => {
    const nodes = lexicalPass([
      e('   ', 'person'),
      e('Ghost', 'wizard' as EntityType),
      e('Sarah Chen', 'person'),
    ])
    expect(names(nodes)).toEqual(['Sarah Chen'])
  })
})

describe('embeddingPass', () => {
  it('merges type-compatible near-duplicates above threshold', async () => {
    const nodes = lexicalPass([e('Sarah Chen', 'person'), e('Chen', 'person')])
    const { fn } = fakeEmbedder({ 'Sarah Chen': at(0), Chen: at(10) })
    const out = await embeddingPass(nodes, 0.8, fn)
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Sarah Chen')
    expect(out[0]!.aliases.sort()).toEqual(['Chen', 'Sarah Chen'])
    expect(out[0]!.mentions).toBe(2)
  })

  it('never merges across incompatible types even at identical similarity', async () => {
    // 'Helix Labs' (organization) vs 'Helix' (artifact) — the company and its product.
    const nodes = lexicalPass([e('Helix Labs', 'organization'), e('Helix', 'artifact')])
    const { fn } = fakeEmbedder({ 'Helix Labs': at(0), Helix: at(0) })
    const out = await embeddingPass(nodes, 0.8, fn)
    expect(out).toHaveLength(2)
    expect(names(out)).toEqual(['Helix', 'Helix Labs'])
  })

  it('keeps same-type nodes apart when similarity is below threshold', async () => {
    const nodes = lexicalPass([e('Sarah Chen', 'person'), e('Marcus Webb', 'person')])
    const { fn } = fakeEmbedder({ 'Sarah Chen': at(0), 'Marcus Webb': at(90) })
    const out = await embeddingPass(nodes, 0.8, fn)
    expect(out).toHaveLength(2)
  })

  it('resolves alias chains transitively via union-find', async () => {
    // A~B and B~C clear the bar; A~C does not. All three are still one entity.
    const nodes = lexicalPass([
      e('Acme Corporation', 'organization'),
      e('Acme Corp', 'organization'),
      e('Acme', 'organization'),
    ])
    const { fn } = fakeEmbedder({
      'Acme Corporation': at(0),
      'Acme Corp': at(30),
      Acme: at(60),
    })
    const out = await embeddingPass(nodes, 0.8, fn)
    expect(out).toHaveLength(1)
    expect(out[0]!.aliases.sort()).toEqual(['Acme', 'Acme Corp', 'Acme Corporation'])
    expect(out[0]!.mentions).toBe(3)
  })

  it('does not let a chain leak across the type boundary', async () => {
    // Helix Labs ~ Helix (org) would merge, and Helix (artifact) is identical to both,
    // but the artifact must stay its own node regardless.
    const nodes = lexicalPass([
      e('Helix Labs', 'organization'),
      e('Helix Genomics', 'organization'),
      e('Helix', 'artifact'),
    ])
    const { fn } = fakeEmbedder({
      'Helix Labs': at(0),
      'Helix Genomics': at(10),
      Helix: at(0),
    })
    const out = await embeddingPass(nodes, 0.8, fn)
    expect(out).toHaveLength(2)
    expect(out.find((n) => n.type === 'artifact')!.aliases).toEqual(['Helix'])
  })

  it('does not embed anything when every type bucket is a singleton', async () => {
    const nodes = lexicalPass([e('Sarah Chen', 'person'), e('Helix Labs', 'organization')])
    const { fn, seen } = fakeEmbedder({})
    const out = await embeddingPass(nodes, 0.8, fn)
    expect(seen).toEqual([])
    expect(out).toHaveLength(2)
  })

  it('embeds name and description together', async () => {
    const nodes = lexicalPass([
      e('Sarah Chen', 'person', 'A biochemist.'),
      e('Chen', 'person', 'The lead researcher.'),
    ])
    const { fn, seen } = fakeEmbedder({ 'Sarah Chen': at(0), Chen: at(90) })
    await embeddingPass(nodes, 0.8, fn)
    expect(seen.sort()).toEqual(['Chen: The lead researcher.', 'Sarah Chen: A biochemist.'])
  })

  it('returns the input untouched for zero or one node', async () => {
    const { fn, seen } = fakeEmbedder({})
    expect(await embeddingPass([], 0.8, fn)).toEqual([])
    const one = lexicalPass([e('Sarah Chen', 'person')])
    expect(await embeddingPass(one, 0.8, fn)).toEqual(one)
    expect(seen).toEqual([])
  })

  it('keeps the graph intact when the embedder fails', async () => {
    const nodes = lexicalPass([e('Sarah Chen', 'person'), e('Chen', 'person')])
    const failing: EmbedFn = async () => {
      throw new Error('raglab-embed 503')
    }
    // Resolution is an enhancement, not a precondition: a dead embedding proxy
    // must degrade to the lexical graph rather than lose the document.
    const out = await embeddingPass(nodes, 0.8, failing)
    expect(out).toHaveLength(2)
  })

  it('is deterministic — the same input always produces the same ids', async () => {
    const build = () =>
      lexicalPass([e('Acme Corporation', 'organization'), e('Acme Corp', 'organization')])
    const { fn } = fakeEmbedder({ 'Acme Corporation': at(0), 'Acme Corp': at(10) })
    const a = await embeddingPass(build(), 0.8, fn)
    const b = await embeddingPass(build(), 0.8, fn)
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id))
  })
})
