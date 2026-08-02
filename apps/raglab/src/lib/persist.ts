import type { ConfigResult } from './engine'
import type { Question } from './metrics'

/**
 * Permalink persistence.
 *
 * Everything here is subordinate to one rule: **no embedding vector may ever be
 * written to Postgres.** The database is 500 MB shared across seven apps, and a
 * single twelve-config run over a hundred-page document is ~11 MB of vectors —
 * forty-five saved runs would consume the whole thing. Vectors live in IndexedDB.
 * This module persists configuration, the question set, gold spans and computed
 * metrics, and it checks itself before every write.
 */

/** Hard ceiling on a serialised run, mirrored by a CHECK constraint in 0004. */
export const MAX_RESULTS_BYTES = 262_144

export interface ExperimentRecord {
  id: string
  slug: string
  doc_name: string
  doc_fingerprint: string
  doc_path: string | null
  questions: Question[]
  created_at: string
}

export interface RunRecord {
  id: string
  experiment_id: string
  results: ConfigResult[]
  created_at: string
}

export class VectorLeakError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to persist: ${reason}. Embeddings belong in IndexedDB, never in the `
      + 'shared database.',
    )
    this.name = 'VectorLeakError'
  }
}

/**
 * Nothing this app legitimately persists is a flat array of 32+ numbers. Metrics
 * are scalars, and retrieval spans are arrays *of pairs*, so their outer elements
 * are arrays rather than numbers.
 */
const VECTOR_LENGTH = 32

/**
 * Walks the structure rather than pattern-matching the JSON.
 *
 * A regex over the serialised payload looks equivalent and is not: real
 * embeddings contain the occasional value that stringifies without a decimal
 * point (`1`, `0`) or in exponential form (`1e-7`), either of which splits a
 * "run of floats" pattern and lets the vector through. Walking the object cannot
 * be fooled that way.
 */
function containsVector(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value.length >= VECTOR_LENGTH && value.every((v) => typeof v === 'number')) return true
    return value.some(containsVector)
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsVector)
  }
  return false
}

/**
 * Last line of defence before an insert.
 *
 * The engine is not supposed to return vectors and its tests say it does not, but
 * this is the one mistake in the project that cannot be undone by a later commit:
 * once forty megabytes of floats are in a shared 500 MB database, six other apps
 * are broken. Three independent checks — a payload size cap, a structural scan for
 * anything vector-shaped, and an excerpt length budget.
 */
export function assertNoVectors(results: ConfigResult[]): void {
  const json = JSON.stringify(results)

  if (json.length > MAX_RESULTS_BYTES) {
    throw new VectorLeakError(
      `serialised results are ${json.length} bytes, above the ${MAX_RESULTS_BYTES} cap`,
    )
  }
  if (containsVector(results)) {
    throw new VectorLeakError(
      `results contain a flat array of ${VECTOR_LENGTH} or more numbers, which is an embedding`,
    )
  }
  for (const r of results) {
    for (const q of r.perQuestion) {
      if (q.retrieved.some((excerpt) => excerpt.length > 400)) {
        throw new VectorLeakError('a retrieved excerpt exceeds the drill-down length budget')
      }
    }
  }
}

/** URL-safe, short, and collision-resistant enough for a portfolio permalink. */
export function makeSlug(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12)
}

async function db() {
  const { supabase } = await import('@labs/platform')
  // PostgREST resolves to `public` unless the schema is chained explicitly.
  return supabase.schema('raglab')
}

export interface SaveInput {
  docName: string
  docFingerprint: string
  docPath?: string | null
  questions: Question[]
  results: ConfigResult[]
}

/**
 * Writes an experiment and its first run, returning the permalink slug.
 *
 * Public read is enabled on both tables so a shared link works without an
 * account. That is disclosed in the UI before the save, and the "local session
 * only" toggle skips this path entirely.
 */
export async function saveRun(input: SaveInput): Promise<{ slug: string; runId: string }> {
  assertNoVectors(input.results)

  const client = await db()
  const slug = makeSlug()

  const { data: experiment, error: experimentError } = await client
    .from('experiments')
    .insert({
      slug,
      doc_name: input.docName,
      doc_fingerprint: input.docFingerprint,
      doc_path: input.docPath ?? null,
      questions: input.questions,
    })
    .select('id')
    .single()
  if (experimentError) throw experimentError

  const { data: run, error: runError } = await client
    .from('runs')
    .insert({ experiment_id: (experiment as { id: string }).id, results: input.results })
    .select('id')
    .single()
  if (runError) throw runError

  return { slug, runId: (run as { id: string }).id }
}

/** Loads a shared benchmark. Readable by anyone with the link, signed in or not. */
export async function loadPermalink(
  slug: string,
): Promise<{ experiment: ExperimentRecord; runs: RunRecord[] } | null> {
  const client = await db()

  // Goes through a SECURITY DEFINER accessor rather than a filtered select.
  // A `for select using (true)` policy would make this work too, but RLS cannot
  // see that we filtered by slug — it would grant the whole table, letting anyone
  // enumerate every benchmark every user has created. The filter has to live
  // inside the security boundary. owner_id is never returned.
  const { data, error } = await client.rpc('experiment_by_slug', { p_slug: slug })
  if (error) throw error

  const row = (data as (ExperimentRecord & { runs: RunRecord[] })[] | null)?.[0]
  if (!row) return null

  const { runs, ...experiment } = row
  return { experiment: experiment as ExperimentRecord, runs: (runs ?? []) as RunRecord[] }
}

export function permalinkUrl(slug: string): string {
  return `${window.location.origin}/raglab/?run=${encodeURIComponent(slug)}`
}
