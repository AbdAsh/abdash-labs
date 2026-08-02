import { describe, it, expect } from 'vitest'
import type { ChunkExtraction, EntityType, RawRelation } from './validate'
import { lexicalPass } from './resolve'
import { assemble, type Graph } from './graph'
import { applyCorrections, type Correction } from './corrections'

const TEXT_1 = 'Dr. Sarah Chen founded Helix Labs in 2019. Helix Labs is based in Rotterdam.'
const TEXT_2 = 'Chen founded Helix Labs after leaving Orbit. Helix Labs later merged with Orbit.'

const chunkTexts = new Map([
  ['c1', TEXT_1],
  ['c2', TEXT_2],
])

const ent = (name: string, type: EntityType, description = '') => ({ name, type, description })
const rel = (source: string, relation: string, target: string, quote: string): RawRelation => ({
  source,
  relation,
  target,
  quote,
})

const CHEN = 'person:chen'
const SARAH = 'person:sarah-chen'
const HELIX = 'organization:helix-labs'
const ROTTERDAM = 'place:rotterdam'
const ORBIT = 'organization:orbit'

function fixture(): Graph {
  const nodes = lexicalPass([
    { entity: ent('Dr. Sarah Chen', 'person', 'A biochemist.'), chunkId: 'c1' },
    { entity: ent('Sarah Chen', 'person'), chunkId: 'c1' },
    { entity: ent('Helix Labs', 'organization', 'A genomics company.'), chunkId: 'c1' },
    { entity: ent('Rotterdam', 'place'), chunkId: 'c1' },
    { entity: ent('Chen', 'person', 'The lead researcher.'), chunkId: 'c2' },
    { entity: ent('Helix Labs', 'organization'), chunkId: 'c2' },
    { entity: ent('Orbit', 'organization'), chunkId: 'c2' },
  ])

  const extractions: ChunkExtraction[] = [
    {
      chunkId: 'c1',
      entities: [],
      relations: [
        rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs'),
        rel('Helix Labs', 'based in', 'Rotterdam', 'Helix Labs is based in Rotterdam'),
      ],
    },
    {
      chunkId: 'c2',
      entities: [],
      relations: [
        rel('Chen', 'founded', 'Helix Labs', 'Chen founded Helix Labs after leaving Orbit'),
        rel('Helix Labs', 'merged with', 'Orbit', 'Helix Labs later merged with Orbit'),
      ],
    },
  ]

  return assemble(extractions, nodes, chunkTexts)
}

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)
const edge = (g: Graph, source: string, relation: string, target: string) =>
  g.edges.find((e) => e.source === source && e.relation === relation && e.target === target)

describe('fixture', () => {
  it('starts with Chen and Sarah Chen as two nodes and two separate founded edges', () => {
    const g = fixture()
    expect(g.nodes).toHaveLength(5)
    expect(edge(g, SARAH, 'founded', HELIX)?.weight).toBe(1)
    expect(edge(g, CHEN, 'founded', HELIX)?.weight).toBe(1)
  })
})

describe('applyCorrections — merge', () => {
  it('combines aliases, mentions and chunk ids', () => {
    const g = applyCorrections(fixture(), [{ kind: 'merge', ids: [SARAH, CHEN] }])
    expect(g.nodes).toHaveLength(4)
    const merged = node(g, SARAH)!
    expect(merged.aliases).toEqual(['Chen', 'Dr. Sarah Chen', 'Sarah Chen'])
    expect(merged.mentions).toBe(3)
    expect(merged.chunkIds.sort()).toEqual(['c1', 'c2'])
    expect(node(g, CHEN)).toBeUndefined()
  })

  it('collapses the two parallel edges into one, summing weight and keeping both quotes', () => {
    const g = applyCorrections(fixture(), [{ kind: 'merge', ids: [SARAH, CHEN] }])
    const founded = edge(g, SARAH, 'founded', HELIX)!
    expect(founded.weight).toBe(2)
    expect(founded.evidence).toHaveLength(2)
    expect(founded.evidence.map((e) => e.chunkId).sort()).toEqual(['c1', 'c2'])
  })

  it('does not duplicate evidence when both sides cite the same passage', () => {
    const base = fixture()
    // Force the two founded edges to carry the identical quote.
    for (const e of base.edges) {
      if (e.relation === 'founded') e.evidence = [{ chunkId: 'c1', quote: 'same passage here' }]
    }
    const g = applyCorrections(base, [{ kind: 'merge', ids: [SARAH, CHEN] }])
    expect(edge(g, SARAH, 'founded', HELIX)!.evidence).toHaveLength(1)
  })

  it('drops an edge that becomes a self-loop', () => {
    const base = fixture()
    base.edges.push({
      id: `${SARAH}|knows|${CHEN}`,
      source: SARAH,
      target: CHEN,
      relation: 'knows',
      weight: 1,
      evidence: [{ chunkId: 'c1', quote: 'Dr. Sarah Chen founded Helix Labs' }],
    })
    const g = applyCorrections(base, [{ kind: 'merge', ids: [SARAH, CHEN] }])
    expect(g.edges.some((e) => e.relation === 'knows')).toBe(false)
  })

  it('ignores ids that are not in the graph', () => {
    const g = applyCorrections(fixture(), [{ kind: 'merge', ids: [SARAH, 'person:nobody'] }])
    expect(g.nodes).toHaveLength(5)
    expect(node(g, SARAH)!.aliases).toEqual(['Dr. Sarah Chen', 'Sarah Chen'])
  })

  it('is a no-op for a group of fewer than two real nodes', () => {
    const before = fixture()
    expect(applyCorrections(before, [{ kind: 'merge', ids: [SARAH] }])).toEqual(before)
    expect(applyCorrections(before, [{ kind: 'merge', ids: [] }])).toEqual(before)
  })

  it('chains transitively across separate merge corrections', () => {
    const g = applyCorrections(fixture(), [
      { kind: 'merge', ids: [SARAH, CHEN] },
      { kind: 'merge', ids: [CHEN, ROTTERDAM] },
    ])
    // All three collapse into one node even though no single correction named all three.
    expect(g.nodes).toHaveLength(3)
  })

  it('honours an explicit cross-type merge, which only a human can request', () => {
    // The type gate governs automatic resolution. A user dragging one visible
    // node onto another is fixing a mis-typed extraction, and must be obeyed.
    const g = applyCorrections(fixture(), [{ kind: 'merge', ids: [HELIX, ORBIT] }])
    expect(g.nodes).toHaveLength(4)
  })

  it('leaves the stats untouched — a correction never rewrites the drop count', () => {
    const before = fixture()
    const g = applyCorrections(before, [{ kind: 'merge', ids: [SARAH, CHEN] }])
    expect(g.stats).toEqual(before.stats)
  })
})

describe('applyCorrections — split', () => {
  const merged = () => applyCorrections(fixture(), [{ kind: 'merge', ids: [SARAH, CHEN] }])

  it('extracts one alias into its own node', () => {
    const g = applyCorrections(merged(), [{ kind: 'split', id: SARAH, alias: 'Chen' }])
    expect(g.nodes).toHaveLength(5)
    expect(node(g, SARAH)!.aliases).toEqual(['Dr. Sarah Chen', 'Sarah Chen'])
    expect(node(g, CHEN)!.aliases).toEqual(['Chen'])
    expect(node(g, CHEN)!.type).toBe('person')
  })

  it('moves only the evidence whose quote names the alias and not the retained name', () => {
    const g = applyCorrections(merged(), [{ kind: 'split', id: SARAH, alias: 'Chen' }])

    const moved = edge(g, CHEN, 'founded', HELIX)!
    expect(moved.evidence.map((e) => e.chunkId)).toEqual(['c2'])

    // "Dr. Sarah Chen founded Helix Labs" contains the substring "Chen", but it
    // also names the retained node, so it must not follow the split.
    const stayed = edge(g, SARAH, 'founded', HELIX)!
    expect(stayed.evidence.map((e) => e.chunkId)).toEqual(['c1'])
  })

  it('leaves untouched edges alone', () => {
    const g = applyCorrections(merged(), [{ kind: 'split', id: SARAH, alias: 'Chen' }])
    expect(edge(g, HELIX, 'based in', ROTTERDAM)!.weight).toBe(1)
    expect(edge(g, HELIX, 'merged with', ORBIT)!.weight).toBe(1)
  })

  it('round-trips a merge back to the original node and edge shape', () => {
    const original = fixture()
    const g = applyCorrections(merged(), [{ kind: 'split', id: SARAH, alias: 'Chen' }])
    expect(g.nodes.map((n) => n.id).sort()).toEqual(original.nodes.map((n) => n.id).sort())
    expect(g.edges.map((e) => e.id).sort()).toEqual(original.edges.map((e) => e.id).sort())
  })

  it('matches the alias case-insensitively', () => {
    const g = applyCorrections(merged(), [{ kind: 'split', id: SARAH, alias: 'chen' }])
    expect(node(g, CHEN)).toBeDefined()
  })

  it('is a no-op for a node with a single alias', () => {
    const before = fixture()
    expect(applyCorrections(before, [{ kind: 'split', id: ROTTERDAM, alias: 'Rotterdam' }])).toEqual(
      before,
    )
  })

  it('is a no-op for an alias the node does not own', () => {
    const before = fixture()
    expect(applyCorrections(before, [{ kind: 'split', id: SARAH, alias: 'Marcus Webb' }])).toEqual(
      before,
    )
  })

  it('is a no-op for an unknown node id', () => {
    const before = fixture()
    expect(applyCorrections(before, [{ kind: 'split', id: 'person:ghost', alias: 'x' }])).toEqual(
      before,
    )
  })

  it('moves the whole edge when no evidence names the retained node', () => {
    const base = merged()
    const founded = edge(base, SARAH, 'founded', HELIX)!
    founded.evidence = [{ chunkId: 'c2', quote: 'Chen founded Helix Labs after leaving Orbit' }]
    const g = applyCorrections(base, [{ kind: 'split', id: SARAH, alias: 'Chen' }])
    expect(edge(g, SARAH, 'founded', HELIX)).toBeUndefined()
    expect(edge(g, CHEN, 'founded', HELIX)).toBeDefined()
  })
})

describe('applyCorrections — algebra', () => {
  const merge: Correction = { kind: 'merge', ids: [SARAH, CHEN] }
  const splitElsewhere: Correction = { kind: 'split', id: HELIX, alias: 'Helix Labs' }

  it('is order-independent', () => {
    const a = applyCorrections(fixture(), [merge, splitElsewhere])
    const b = applyCorrections(fixture(), [splitElsewhere, merge])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('is idempotent', () => {
    const cs: Correction[] = [merge, { kind: 'split', id: ORBIT, alias: 'Orbit' }]
    const once = applyCorrections(fixture(), cs)
    const twice = applyCorrections(once, cs)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('lets a split override a merge that would undo it', () => {
    // Contradictory instructions in one list resolve to "the separation stands",
    // which is also what makes merge-then-split idempotent across reloads.
    const g = applyCorrections(fixture(), [
      { kind: 'merge', ids: [SARAH, CHEN] },
      { kind: 'split', id: SARAH, alias: 'Chen' },
    ])
    expect(node(g, SARAH)).toBeDefined()
    expect(node(g, CHEN)).toBeDefined()
  })

  it('ignores malformed corrections instead of throwing', () => {
    const before = fixture()
    const junk = [
      null,
      { kind: 'rotate' },
      { kind: 'merge' },
      { kind: 'split', id: SARAH },
    ] as unknown as Correction[]
    expect(applyCorrections(before, junk)).toEqual(before)
  })

  it('returns the graph unchanged for an empty correction list', () => {
    const before = fixture()
    expect(applyCorrections(before, [])).toEqual(before)
  })

  it('does not mutate the graph it was given', () => {
    const before = fixture()
    const snapshot = JSON.stringify(before)
    applyCorrections(before, [{ kind: 'merge', ids: [SARAH, CHEN] }])
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
