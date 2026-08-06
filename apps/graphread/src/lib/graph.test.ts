import { describe, it, expect } from 'vitest'
import { nameAppearsIn, type ChunkExtraction, type EntityType, type RawRelation } from './validate'
import { embeddingPass, lexicalPass, type EmbedFn, type ResolvedNode } from './resolve'
import { assemble, degrees, neighbourhood } from './graph'

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

  it('drops a relation whose quote is real but says nothing about its endpoints', () => {
    // The quote is verbatim in c1. It is not about Marcus Webb and Rotterdam.
    const g = assemble(
      [
        extraction(
          'c1',
          [],
          [rel('Marcus Webb', 'founded', 'Rotterdam', 'Dr. Sarah Chen founded Helix Labs')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.edges).toHaveLength(0)
    expect(g.stats.droppedRelations).toBe(1)
  })

  it('keeps an entity that no surviving relation mentions', () => {
    // Marcus Webb and Rotterdam are extracted but unconnected. They belong in
    // the graph: the document named them, and an isolated node is information.
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
    const d = degrees(g)
    expect(g.nodes.map((n) => n.id)).toContain('person:marcus-webb')
    expect(d.get('person:marcus-webb')).toBe(0)
    // An orphan's neighbourhood is itself, so isolating one cannot blank the view.
    expect([...neighbourhood(g, 'person:marcus-webb')]).toEqual(['person:marcus-webb'])
  })

  it('shrugs off a chunk that yielded nothing at all', () => {
    const g = assemble(
      [
        extraction('c1', [], []),
        extraction(
          'c2',
          [],
          [rel('sarah chen', 'founded', 'Helix Labs', 'Chen founded Helix Labs after leaving Orbit')],
        ),
      ],
      resolvedNodes(),
      chunkTexts,
    )
    expect(g.stats.chunks).toBe(2)
    expect(g.edges).toHaveLength(1)
  })
})

describe('assemble — provenance after automatic resolution', () => {
  /** Fake embedder: identical vectors, so the two person nodes fuse. */
  const fuse: EmbedFn = async (texts) => texts.map(() => [1, 0])

  it('fuses two mentions into one node and keeps both passages under one edge', async () => {
    const nodes = await embeddingPass(
      lexicalPass([
        { entity: ent('Dr. Sarah Chen', 'person'), chunkId: 'c1' },
        { entity: ent('Chen', 'person'), chunkId: 'c2' },
        { entity: ent('Helix Labs', 'organization'), chunkId: 'c1' },
      ]),
      0.8,
      fuse,
    )

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
      nodes,
      chunkTexts,
    )

    expect(g.edges).toHaveLength(1)
    const founded = g.edges[0]!
    expect(founded.weight).toBe(2)

    // Both quotes survive, and each is still the passage that used that surface
    // form. An automatic merge that dropped or swapped one would keep the count.
    const c1 = founded.evidence.find((e) => e.chunkId === 'c1')!
    const c2 = founded.evidence.find((e) => e.chunkId === 'c2')!
    expect(nameAppearsIn(c1.quote, 'Dr. Sarah Chen')).toBe(true)
    expect(c2.quote).toContain('Chen founded Helix Labs after leaving Orbit')
    for (const e of founded.evidence) {
      expect(chunkTexts.get(e.chunkId)).toContain(e.quote)
    }
  })
})

describe('assemble — a document large enough to be a real one', () => {
  it('builds a 400-entity graph without quadratic blow-up or dropped provenance', () => {
    const N = 400
    const chunks = new Map<string, string>()
    const extractions: ChunkExtraction[] = []
    const mentions: { entity: ReturnType<typeof ent>; chunkId: string }[] = []

    for (let i = 0; i < N; i++) {
      const id = `k${i}`
      const a = `Person ${i}`
      const b = `Org ${i}`
      const text = `${a} founded ${b} in 2019. ${a} still runs it.`
      chunks.set(id, text)
      mentions.push({ entity: ent(a, 'person'), chunkId: id })
      mentions.push({ entity: ent(b, 'organization'), chunkId: id })
      extractions.push(extraction(id, [], [rel(a, 'founded', b, `${a} founded ${b}`)]))
    }

    const started = Date.now()
    const g = assemble(extractions, lexicalPass(mentions), chunks)
    expect(Date.now() - started).toBeLessThan(4000)

    expect(g.nodes).toHaveLength(N * 2)
    expect(g.edges).toHaveLength(N)
    expect(g.stats.droppedRelations).toBe(0)
    expect(g.stats.unresolvedRelations).toBe(0)
    expect(degrees(g).get('person:person-0')).toBe(1)
  })
})
