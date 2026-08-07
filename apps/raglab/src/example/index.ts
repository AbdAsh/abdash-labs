import type { MatrixSelection } from '../lib/engine'
import type { Question } from '../lib/metrics'
import type { ConfigResult } from '../lib/engine'
import { normaliseQuestions, normaliseResults } from '../lib/persist'
import raw from './benchmark.json'

/**
 * The bundled finished benchmark.
 *
 * A real run takes most of a minute and spends one of an anonymous visitor's two
 * daily allowance, so the app opens on a result that is already scored: instant,
 * free, and identical to what the Run button produces. Every number in
 * `benchmark.json` was measured against the deployed `raglab-embed` function by
 * `scripts/record-example.mjs`. Nothing in it is written, adjusted or rounded by
 * hand, and there is no code path that can produce this file any other way.
 *
 * Metrics only — no vectors, deliberately, and the recorder runs the app's own
 * `assertNoVectors` over the file before writing it. A fixture full of floats
 * would be both enormous and a contradiction of the argument the app is making.
 */

export interface ExampleProvenance {
  /** ISO timestamp of the run that produced these numbers. */
  capturedAt: string
  source: string
  /** The quota tier it ran under. Anonymous, the same as a first-time visitor. */
  tier: string
  elapsedMs: number
  httpBatches: number
  vectorsPurchased: number
  charactersEmbedded: number
  /**
   * Distinct run identities the Edge Function minted. One is the interesting
   * number: it means twelve configurations were charged as a single unit of
   * `raglab:runs`, which is the whole point of signing the run token.
   */
  runIds: number
  quotaUnits: number
  /** True when some vectors came from a local cache rather than a fresh call. */
  cacheAssisted: boolean
  /** Coverage of the gold passage a chunk needs before it counts as a hit. */
  hitThreshold: number
  /** Dimensions as reported by the live function, not from documentation. */
  models: { id: string; label: string; dims: number | null }[]
}

export interface ExampleDocument {
  id: string
  title: string
  source: string
  license: string
  characters: number
  fingerprint: string
}

export interface ExampleRunFixture {
  schema: number
  provenance: ExampleProvenance
  document: ExampleDocument
  matrix: MatrixSelection
  questions: Question[]
  results: ConfigResult[]
}

/**
 * The heavy arrays go through the same normalisers a permalink does.
 *
 * `benchmark.json` is read by code that may be newer than the file — a fixture
 * recorded before a field existed is exactly the situation `normaliseResults`
 * was written for. Reusing it means the example and a shared run reach the
 * components through one boundary with one set of rules, instead of the fixture
 * being cast into shape and quietly skipping the checks.
 */
export const EXAMPLE_RUN: ExampleRunFixture = {
  schema: raw.schema,
  provenance: raw.provenance,
  document: raw.document,
  matrix: raw.matrix as MatrixSelection,
  questions: normaliseQuestions(raw.questions),
  results: normaliseResults(raw.results),
}
