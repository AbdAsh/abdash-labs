import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assemble } from '../lib/graph'
import { lexicalPass } from '../lib/resolve'
import {
  nameAppearsIn,
  quoteSupportedBy,
  validateExtraction,
  type ChunkExtraction,
  type RawEntity,
} from '../lib/validate'
import sourceJson from './source.json'

const GRAPH_PATH = fileURLToPath(new URL('./demo-graph.json', import.meta.url))

const source = sourceJson as unknown as {
  docName: string
  extractedOn: string
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

  it('names one endpoint in every quote', () => {
    for (const extraction of source.extractions) {
      for (const r of extraction.relations) {
        expect(
          nameAppearsIn(r.quote, r.source) || nameAppearsIn(r.quote, r.target),
          `${extraction.chunkId}: ${JSON.stringify(r.quote)} names neither ${r.source} nor ${r.target}`,
        ).toBe(true)
      }
    }
  })

  it('is a recording, not a rewrite — nothing here was repaired by hand', () => {
    // The committed extraction is what the deployed function returned, warts
    // included. The warts are the point: five of its relations hang off a bare
    // noun the model never listed as an entity ("field programme", "within the
    // year"), and the resolver refuses all five below. Quietly deleting them
    // from this file would turn an honest recording into a brochure, and would
    // hide the one failure mode the quote gate cannot catch on its own.
    const listed = new Set(source.extractions.flatMap((x) => x.entities.map((e) => e.name)))
    const danglers = source.extractions.flatMap((x) =>
      x.relations.filter((r) => !listed.has(r.source) || !listed.has(r.target)),
    )
    expect(danglers).toHaveLength(5)
    expect(source.extractedOn).toBe('2026-08-07')
  })
})

describe('demo graph', () => {
  const built = buildDemoGraph()

  it('matches the committed demo-graph.json', () => {
    const serialized = `${JSON.stringify(built, null, 2)}\n`
    if (process.env.UPDATE_DEMO === '1') writeFileSync(GRAPH_PATH, serialized)
    expect(serialized).toBe(readFileSync(GRAPH_PATH, 'utf8'))
  })

  it('loses nothing at the quote gate', () => {
    // Zero is the number that matters, and it is not luck: every quote in the
    // recording was checked against its chunk and every one of them held.
    expect(built.stats.droppedRelations).toBe(0)
  })

  it('refuses the five relations whose endpoints were never named', () => {
    // Counted, not hidden — the UI shows this number, because "we could not
    // place 5 of 23 claims" is an honest thing to say about a model.
    expect(built.stats.unresolvedRelations).toBe(5)
    expect(built.stats.keptRelations).toBe(18)
  })

  it('quotes every edge verbatim, naming one of its own endpoints', () => {
    // The end-to-end restatement of the two gates, checked against the graph
    // the user actually sees rather than against the input that produced it.
    const byId = new Map(built.nodes.map((n) => [n.id, n]))
    for (const edge of built.edges) {
      const from = byId.get(edge.source)!
      const to = byId.get(edge.target)!
      for (const evidence of edge.evidence) {
        const text = chunkTexts.get(evidence.chunkId)
        expect(quoteSupportedBy(evidence.quote, text!), `${edge.id}: not in ${evidence.chunkId}`).toBe(
          true,
        )
        const names = [from.name, ...from.aliases, to.name, ...to.aliases]
        expect(
          names.some((n) => nameAppearsIn(evidence.quote, n)),
          `${edge.id}: ${JSON.stringify(evidence.quote)} names neither end`,
        ).toBe(true)
      }
    }
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

  it('leaves the same founding on two edges, because the model used two verbs', () => {
    // c0 says Chen "founded" Helix Labs and c2 says she "started" it. Relation
    // labels are free text taken from the passage, so those are two edges, and
    // no amount of prompt work reliably makes a model pick one verb twice.
    // This is exactly what the merge correction in the UI is for, and a demo
    // that quietly hand-edited the second verb would be hiding the seam.
    const chenToLabs = built.edges.filter(
      (e) => e.source === 'person:sarah-chen' && e.target === 'organization:helix-labs',
    )
    expect(chenToLabs.map((e) => e.relation).sort()).toEqual(['founded', 'started'])
    expect(chenToLabs.flatMap((e) => e.evidence.map((x) => x.chunkId)).sort()).toEqual(['c0', 'c2'])
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

  it('agrees with the gate run directly over the recording', () => {
    // Belt and braces: assemble() runs the gate internally, so re-running it
    // here from the outside proves the graph's own drop count is not just a
    // number assemble() decided to report.
    let dropped = 0
    for (const x of source.extractions) {
      dropped += validateExtraction(x, chunkTexts.get(x.chunkId) ?? '').dropped.length
    }
    expect(dropped).toBe(built.stats.droppedRelations)
  })
})
