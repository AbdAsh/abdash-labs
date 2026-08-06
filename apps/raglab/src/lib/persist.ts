import type { ConfigResult, PerQuestionResult } from './engine'
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

/** Hard ceiling on a serialised run, mirrored by a trigger in 0004. */
export const MAX_RESULTS_BYTES = 262_144

/** Hard ceiling on a serialised question set, mirrored by the same trigger. */
export const MAX_QUESTIONS_BYTES = 65_536

/**
 * How much of a gold passage travels with a permalink.
 *
 * A permalink is read without the document, so the drill-down has nothing to show
 * as "the answer you were looking for" unless the passage comes along. Bounded
 * because a gold span is user-drawn and can legitimately be half the document:
 * fifteen unbounded spans would push the question set past its 64 KB budget and
 * the save would fail at the very end of a run the user already paid for.
 */
export const MAX_GOLD_TEXT = 240

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

/**
 * Attaches a bounded copy of each gold passage so a permalink can render the
 * drill-down without the document.
 *
 * Offsets are left exactly as they are: they index the document, not this
 * excerpt, and rewriting them to match a truncation would corrupt the one
 * coordinate system the whole app agrees on.
 */
export function withGoldText(text: string, questions: Question[]): Question[] {
  return questions.map((q) => {
    const passage = text.slice(q.gold.start, q.gold.end)
    return {
      ...q,
      goldText: passage.length > MAX_GOLD_TEXT
        ? `${passage.slice(0, MAX_GOLD_TEXT - 1)}…`
        : passage,
    }
  })
}

/* -------------------------------------------------------------------------
 * Reading back what an older build wrote
 * ---------------------------------------------------------------------- */

/**
 * A permalink is read long after it was written, so a saved run is the one place
 * in this app where the data on the wire is routinely a *different version* of
 * the type than the code reading it. That is the normal case here, not an edge
 * case, and it is why normalisation happens once at this boundary rather than as
 * `??` at each read site: the leaderboard, the chart and the drill-down all read
 * these objects, and a guard added to one of them is a guard the other two
 * silently lack.
 *
 * The rule for a missing field is: derive it when it is recoverable, and
 * represent it as "not recorded" when it is not. Never default it to a value
 * that reads as a measurement.
 */
const num = (v: unknown, fallback: number): number =>
  (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function normalisePerQuestion(raw: unknown): PerQuestionResult {
  const r = (raw ?? {}) as Record<string, unknown>
  const rr = num(r.rr, 0)
  const hit = typeof r.hit === 'boolean' ? r.hit : rr > 0

  return {
    questionId: typeof r.questionId === 'string' ? r.questionId : '',
    hit,
    rr,
    retrieved: Array.isArray(r.retrieved) ? r.retrieved.filter((x) => typeof x === 'string') : [],
    spans: Array.isArray(r.spans)
      ? (r.spans.filter((s) => Array.isArray(s) && s.length === 2) as [number, number][])
      : [],
    // Recoverable: `rr` is 1/rank by definition, so every *hit* in a run that
    // predates this field still knows exactly where its answer ranked. Only
    // misses lose the information, because a pre-field run never looked past k.
    firstHitRank: r.firstHitRank === null || r.firstHitRank === undefined
      ? (rr > 0 ? Math.round(1 / rr) : null)
      : num(r.firstHitRank, 1),
    bestOverlap: typeof r.bestOverlap === 'number' ? r.bestOverlap : null,
  }
}

/** Coerces a stored run into the shape every reader downstream is allowed to assume. */
export function normaliseResults(raw: unknown): ConfigResult[] {
  if (!Array.isArray(raw)) return []
  const out: ConfigResult[] = []
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>
    const config = r.config as Record<string, unknown> | undefined
    // A row with no configuration cannot be labelled, ranked or charted. There is
    // nothing honest to render for it, so it is dropped rather than shown as a
    // nameless entry in a leaderboard.
    if (!config || typeof config.chunker !== 'string') continue

    const perQuestion = Array.isArray(r.perQuestion)
      ? r.perQuestion.map(normalisePerQuestion)
      : []

    out.push({
      config: {
        chunker: config.chunker as ConfigResult['config']['chunker'],
        size: num(config.size, 0),
        overlap: num(config.overlap, 0),
        model: typeof config.model === 'string' ? config.model : 'unknown',
        k: num(config.k, perQuestion[0]?.spans.length ?? 0),
      },
      hitRate: num(r.hitRate, 0),
      mrr: num(r.mrr, 0),
      chunkCount: num(r.chunkCount, 0),
      perQuestion,
    })
  }
  return out
}

/** Coerces a stored question set, dropping entries with no usable gold span. */
export function normaliseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const item of raw) {
    const q = (item ?? {}) as Record<string, unknown>
    const gold = (q.gold ?? {}) as Record<string, unknown>
    if (typeof q.id !== 'string' || typeof gold.start !== 'number' || typeof gold.end !== 'number') {
      continue
    }
    out.push({
      id: q.id,
      text: typeof q.text === 'string' ? q.text : '',
      gold: { start: gold.start, end: gold.end },
      ...(typeof q.goldText === 'string' ? { goldText: q.goldText } : {}),
    })
  }
  return out
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
  /** The scored text. Only the gold passages are kept, never the document. */
  docText: string
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

  const questions = withGoldText(input.docText, input.questions)
  const questionBytes = JSON.stringify(questions).length
  if (questionBytes > MAX_QUESTIONS_BYTES) {
    // Caught here rather than at the database trigger so the message names the
    // cause. A run reaches this point already paid for; a raw constraint
    // violation at the last step is the worst possible moment for a bad error.
    throw new RangeError(
      `Refusing to persist: the question set is ${questionBytes} bytes, above the `
      + `${MAX_QUESTIONS_BYTES} byte cap. Either there are too many questions or a gold span `
      + 'covers most of the document. The scores are still on screen.',
    )
  }

  const client = await db()
  const slug = makeSlug()

  const { data: experiment, error: experimentError } = await client
    .from('experiments')
    .insert({
      slug,
      doc_name: input.docName,
      doc_fingerprint: input.docFingerprint,
      doc_path: input.docPath ?? null,
      questions,
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

  const row = (data as Record<string, unknown>[] | null)?.[0]
  if (!row) return null

  // Everything past this line is normalised. Downstream readers get the current
  // shape whatever version of this app wrote the row.
  const { runs, questions, ...experiment } = row
  return {
    experiment: {
      ...(experiment as Omit<ExperimentRecord, 'questions'>),
      questions: normaliseQuestions(questions),
    },
    runs: (Array.isArray(runs) ? runs : []).map((r) => {
      const run = r as Record<string, unknown>
      return {
        id: String(run.id ?? ''),
        experiment_id: String(run.experiment_id ?? ''),
        created_at: String(run.created_at ?? ''),
        results: normaliseResults(run.results),
      }
    }),
  }
}

export function permalinkUrl(slug: string): string {
  return `${window.location.origin}/raglab/?run=${encodeURIComponent(slug)}`
}
