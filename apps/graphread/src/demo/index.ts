/**
 * The preloaded demo graph.
 *
 * `demo-graph.json` is committed rather than computed, so the AI-tab card and
 * the landing page open a finished graph with no upload, no API call and no
 * marginal cost. `source.json` ships beside it because provenance is the whole
 * point: clicking an edge in the demo must show you the passage it came from,
 * and that passage has to exist somewhere.
 *
 * `demo.test.ts` regenerates the graph from `source.json` and asserts it equals
 * the committed file, so the two can never drift.
 */

import demoGraph from './demo-graph.json'
import source from './source.json'
import type { Graph } from '../lib/graph'
import type { ChunkExtraction } from '../lib/validate'
import type { SourceChunk } from '../lib/extract'

export interface DemoSource {
  docName: string
  note: string
  chunks: SourceChunk[]
  extractions: ChunkExtraction[]
}

export const demoSource = source as DemoSource

export const DEMO_DOC_NAME = demoSource.docName

export const demoChunkPages: Map<string, number> = new Map(
  demoSource.chunks.map((c) => [c.id, c.page]),
)

export const DEMO_GRAPH = demoGraph as unknown as Graph
