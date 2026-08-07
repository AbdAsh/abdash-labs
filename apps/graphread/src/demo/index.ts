/**
 * The preloaded demo graph — one finished extraction, saved.
 *
 * `demo-graph.json` is committed rather than computed, so the AI-tab card and
 * the landing page open a finished graph with no upload, no API call and no
 * marginal cost. Nobody spends a day's allowance to find out what the tool
 * does. `source.json` ships beside it because provenance is the whole point:
 * clicking an edge in the demo must show you the passage it came from, and that
 * passage has to exist somewhere.
 *
 * What is committed is a recording, not a mock-up. The passages were written
 * for the demo, but the entities and relations beside them are exactly what the
 * deployed extractor returned when it was run over those passages on
 * `extractedOn`, unedited — including the five relations it hung off nouns it
 * never named, which the resolver then refused. A demo that had been tidied up
 * would be advertising a product that does not exist.
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
  /** ISO date of the live run this file records. Shown in the UI. */
  extractedOn: string
  note: string
  chunks: SourceChunk[]
  extractions: ChunkExtraction[]
}

export const demoSource = source as DemoSource

export const DEMO_DOC_NAME = demoSource.docName

/**
 * "7 August 2026" — the day the saved extraction was actually run, spelled out
 * for the demo bar. Fixed to en-GB and UTC rather than the visitor's locale:
 * this is a fact about the recording, so every visitor must be shown the same
 * date, and a timezone west of UTC would otherwise render it as the 6th.
 */
export const DEMO_EXTRACTED_ON_LABEL = new Date(
  `${demoSource.extractedOn}T00:00:00Z`,
).toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export const demoChunkPages: Map<string, number> = new Map(
  demoSource.chunks.map((c) => [c.id, c.page]),
)

export const DEMO_GRAPH = demoGraph as unknown as Graph
