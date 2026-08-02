import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assemble } from '../lib/graph'
import { lexicalPass } from '../lib/resolve'
import { quoteSupportedBy, type ChunkExtraction, type RawEntity } from '../lib/validate'
import sourceJson from './source.json'

const GRAPH_PATH = fileURLToPath(new URL('./demo-graph.json', import.meta.url))

const source = sourceJson as unknown as {
  docName: string
  chunks: { id: string; page: number; content: string }[]
  extractions: ChunkExtraction[]
}

const chunkTexts = new Map(source.chunks.map((c) => [c.id, c.content]))

/**
 * The demo graph is built by the same code path a real document takes — only
 * the extraction step is replaced by committed JSON. The embedding pass is
 * skipped because it needs the network; the demo source is written so the
 * lexical pass alone resolves it correctly.
 */
function buildDemoGraph() {
  const mentions = source.extractions.flatMap((x) =>
    x.entities.map((entity: RawEntity) => ({ entity, chunkId: x.chunkId })),
  )
  return assemble(source.extractions, lexicalPass(mentions), chunkTexts)
}

describe('demo source', () => {
  it('quotes every relation verbatim from its own chunk', () => {
    // If this fails, the committed demo violates the gate the product sells.
    for (const extraction of source.extractions) {
      const text = chunkTexts.get(extraction.chunkId)
      expect(text, `missing chunk ${extraction.chunkId}`).toBeTruthy()
      for (const relation of extraction.relations) {
        expect(
          quoteSupportedBy(relation.quote, text!),
          `${extraction.chunkId}: ${JSON.stringify(relation.quote)}`,
        ).toBe(true)
      }
    }
  })

  it('names an extracted entity at both ends of every relation', () => {
    for (const extraction of source.extractions) {
      const known = new Set(source.extractions.flatMap((x) => x.entities.map((e) => e.name)))
      for (const r of extraction.relations) {
        expect(known.has(r.source), `${extraction.chunkId} source ${r.source}`).toBe(true)
        expect(known.has(r.target), `${extraction.chunkId} target ${r.target}`).toBe(true)
      }
    }
  })
})

describe('demo graph', () => {
  const built = buildDemoGraph()

  it('matches the committed demo-graph.json', () => {
    const serialized = `${JSON.stringify(built, null, 2)}\n`
    if (process.env.UPDATE_DEMO === '1') writeFileSync(GRAPH_PATH, serialized)
    expect(serialized).toBe(readFileSync(GRAPH_PATH, 'utf8'))
  })

  it('drops nothing — a demo that fails its own gate is not a demo', () => {
    expect(built.stats.droppedRelations).toBe(0)
    expect(built.stats.unresolvedRelations).toBe(0)
  })

  it('keeps the company and its product as two nodes', () => {
    // The type gate, visible on screen: Helix Labs is an organization and
    // Helix is the sequencer it ships.
    const ids = built.nodes.map((n) => n.id)
    expect(ids).toContain('organization:helix-labs')
    expect(ids).toContain('artifact:helix')
  })

  it('merges the honorific variant into one person', () => {
    const chen = built.nodes.find((n) => n.id === 'person:sarah-chen')!
    expect(chen.aliases.sort()).toEqual(['Dr. Sarah Chen', 'Sarah Chen'])
    expect(chen.mentions).toBeGreaterThan(2)
  })

  it('collapses the twice-asserted founding into one edge with two quotes', () => {
    const founded = built.edges.find(
      (e) =>
        e.source === 'person:sarah-chen' &&
        e.relation === 'founded' &&
        e.target === 'organization:helix-labs',
    )!
    expect(founded.weight).toBe(2)
    expect(founded.evidence.map((x) => x.chunkId).sort()).toEqual(['c0', 'c2'])
  })

  it('points every edge at a node that exists', () => {
    const ids = new Set(built.nodes.map((n) => n.id))
    for (const e of built.edges) {
      expect(ids.has(e.source), e.id).toBe(true)
      expect(ids.has(e.target), e.id).toBe(true)
    }
  })

  it('is small enough to open instantly', () => {
    expect(JSON.stringify(built).length).toBeLessThan(64_000)
    expect(built.nodes.length).toBeGreaterThan(6)
    expect(built.edges.length).toBeGreaterThan(12)
  })
})
