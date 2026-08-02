import { describe, it, expect } from 'vitest'
import type { ChunkExtraction, EntityType, RawRelation } from './validate'
import { lexicalPass, type ResolvedNode } from './resolve'
import { assemble } from './graph'

const TEXT_1 =
  'Dr. Sarah Chen founded Helix Labs in 2019. Helix Labs is based in Rotterdam. ' +
  'Marcus Webb joined Helix Labs as chief scientist.'
const TEXT_2 =
  'Chen founded Helix Labs after leaving Orbit. Helix Labs later merged with Orbit.'

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

const extraction = (
  chunkId: string,
  entities: ReturnType<typeof ent>[],
  relations: RawRelation[],
): ChunkExtraction => ({ chunkId, entities, relations })

/** The node set the resolver would have produced for the two chunks above. */
function resolvedNodes(): ResolvedNode[] {
  return lexicalPass([
    { entity: ent('Dr. Sarah Chen', 'person'), chunkId: 'c1' },
    { entity: ent('Helix Labs', 'organization'), chunkId: 'c1' },
    { entity: ent('Marcus Webb', 'person'), chunkId: 'c1' },
    { entity: ent('Rotterdam', 'place'), chunkId: 'c1' },
    { entity: ent('Helix Labs', 'organization'), chunkId: 'c2' },
    { entity: ent('Orbit', 'organization'), chunkId: 'c2' },
  ])
}

const edgeBetween = (g: ReturnType<typeof assemble>, a: string, b: string) =>
  g.edges.find((e) => e.source === a && e.target === b)

describe('assemble', () => {
  it('resolves relation endpoints to merged node ids via alias lookup', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]!.source).toBe('person:sarah-chen')
    expect(g.edges[0]!.target).toBe('organization:helix-labs')
  })

  it('matches an endpoint written as any recorded alias', () => {
    // The model wrote "sarah chen" in chunk 2 but "Dr. Sarah Chen" in chunk 1.
    const nodes = lexicalPass([
      { entity: ent('Dr. Sarah Chen', 'person'), chunkId: 'c1' },
      { entity: ent('Helix Labs', 'organization'), chunkId: 'c2' },
    ])
    const g = assemble(
      [
        extraction(
          'c2',
          [],
          [rel('sarah chen', 'founded', 'HELIX LABS', 'Chen founded Helix Labs after leaving Orbit')],
        ),
      ],
      nodes,
      chunkTexts,
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]!.source).toBe('person:sarah-chen')
  })

  it('drops a relation whose endpoint resolves to nothing', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Nobody At All', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(0)
    expect(g.stats.unresolvedRelations).toBe(1)
    // An unresolvable endpoint is not a hallucinated quote; the counts stay apart.
    expect(g.stats.droppedRelations).toBe(0)
  })

  it('collapses a repeated relation into one edge, incrementing weight and keeping both quotes', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
        extraction(
          'c2',
          [],
          [rel('Chen', 'founded', 'Helix Labs', 'Chen founded Helix Labs after leaving Orbit')],
        ),
      ],
      lexicalPass([
        { entity: ent('Dr. Sarah Chen', 'person'), chunkId: 'c1' },
        { entity: ent('Chen', 'person'), chunkId: 'c2' },
        { entity: ent('Helix Labs', 'organization'), chunkId: 'c1' },
      ]),
      chunkTexts,
    )
    // 'Chen' and 'Sarah Chen' stay separate lexically, so this asserts the
    // *identical* endpoint case rather than the merged one.
    const merged = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
        extraction(
          'c2',
          [],
          [rel('sarah chen', 'founded', 'Helix Labs', 'Chen founded Helix Labs after leaving Orbit')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges.length).toBeGreaterThan(0)
    expect(merged.edges).toHaveLength(1)
    expect(merged.edges[0]!.weight).toBe(2)
    expect(merged.edges[0]!.evidence).toHaveLength(2)
    expect(merged.edges[0]!.evidence.map((e) => e.chunkId).sort()).toEqual(['c1', 'c2'])
  })

  it('counts quote-gate failures in droppedRelations and lets none through', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [
            rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs'),
            rel('Dr. Sarah Chen', 'sold', 'Helix Labs', 'Sarah Chen sold Helix Labs to Orbit'),
            rel('Marcus Webb', 'leads', 'Helix Labs', 'Marcus Webb leads Helix Labs'),
          ],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.stats.droppedRelations).toBe(2)
    expect(g.edges).toHaveLength(1)
    for (const e of g.edges) {
      for (const ev of e.evidence) {
        expect(chunkTexts.get(ev.chunkId)!.replace(/\s+/g, ' ')).toContain(
          ev.quote.replace(/\s+/g, ' '),
        )
      }
    }
  })

  it('drops every relation of a chunk whose text is unavailable', () => {
    const g = assemble(
      [
        extraction(
          'c99',
          [],
          [rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(0)
    expect(g.stats.droppedRelations).toBe(1)
  })

  it('normalises the relation label so casing does not fork an edge', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Dr. Sarah Chen', 'Founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
        extraction(
          'c2',
          [],
          [rel('sarah chen', 'FOUNDED  ', 'Helix Labs', 'Chen founded Helix Labs after leaving Orbit')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]!.relation).toBe('founded')
    expect(g.edges[0]!.weight).toBe(2)
  })

  it('keeps direction — A founded B is not B founded A', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [
            rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs'),
            rel('Helix Labs', 'founded', 'Dr. Sarah Chen', 'Dr. Sarah Chen founded Helix Labs'),
          ],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(2)
    expect(edgeBetween(g, 'person:sarah-chen', 'organization:helix-labs')).toBeDefined()
    expect(edgeBetween(g, 'organization:helix-labs', 'person:sarah-chen')).toBeDefined()
  })

  it('drops a self-loop', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Dr. Sarah Chen', 'is', 'sarah chen', 'Dr. Sarah Chen founded Helix Labs')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(0)
    expect(g.stats.unresolvedRelations).toBe(1)
  })

  it('does not duplicate identical evidence asserted twice in the same chunk', () => {
    const quote = 'Dr. Sarah Chen founded Helix Labs'
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [
            rel('Dr. Sarah Chen', 'founded', 'Helix Labs', quote),
            rel('Dr. Sarah Chen', 'founded', 'Helix Labs', quote),
          ],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]!.weight).toBe(2)
    expect(g.edges[0]!.evidence).toHaveLength(1)
  })

  it('disambiguates a same-name endpoint using the chunk it was asserted in', () => {
    // "Orbit" is both a company and a product. The relation lives in c2, where
    // only the organization was seen, so that is the one it must attach to.
    const nodes = lexicalPass([
      { entity: ent('Orbit', 'organization'), chunkId: 'c2' },
      { entity: ent('Orbit', 'artifact'), chunkId: 'c1' },
      { entity: ent('Helix Labs', 'organization'), chunkId: 'c2' },
    ])
    const g = assemble(
      [
        extraction(
          'c2',
          [],
          [rel('Helix Labs', 'merged with', 'Orbit', 'Helix Labs later merged with Orbit')],
        ),
      ],
      nodes,
      chunkTexts,
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]!.target).toBe('organization:orbit')
  })

  it('reports chunk and kept counts', () => {
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs')],
        ),
        extraction('c2', [], []),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.stats.chunks).toBe(2)
    expect(g.stats.keptRelations).toBe(1)
    expect(g.nodes).toHaveLength(resolvedNodes().length)
  })

  it('orders edges deterministically so a permalink round-trips identically', () => {
    const build = () =>
      assemble(
        [
          extraction(
            'c1',
            [],
            [
              rel('Dr. Sarah Chen', 'founded', 'Helix Labs', 'Dr. Sarah Chen founded Helix Labs'),
              rel('Helix Labs', 'based in', 'Rotterdam', 'Helix Labs is based in Rotterdam'),
              rel(
                'Marcus Webb',
                'joined',
                'Helix Labs',
                'Marcus Webb joined Helix Labs as chief scientist',
              ),
            ],
          ),
        ],
        resolvedNodes(),
        chunkTexts,
      )
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
    expect(build().edges).toHaveLength(3)
  })

  it('survives an empty document', () => {
    const g = assemble([], [], new Map())
    expect(g).toEqual({
      nodes: [],
      edges: [],
      stats: { chunks: 0, keptRelations: 0, droppedRelations: 0, unresolvedRelations: 0 },
    })
  })
})
