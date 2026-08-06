import { chunkWith, chunkerLabel, type ChunkerId, type SpanChunk } from './chunkers'
import { cacheKey, getCached, putCached, quantize } from './cache'
import {
  DEFAULT_THRESHOLD,
  aggregate,
  bestOverlap,
  isHit,
  minChunkSizeToHit,
  reciprocalRank,
  type GoldSpan,
  type Question,
} from './metrics'

/** One point in the comparison matrix. */
export interface Config {
  chunker: ChunkerId
  size: number
  overlap: number
  model: string
  k: number
}

export interface MatrixSelection {
  chunkers: ChunkerId[]
  sizes: number[]
  overlaps: number[]
  models: string[]
  ks: number[]
}

export interface PerQuestionResult {
  questionId: string
  hit: boolean
  rr: number
  /** Short excerpts of the top-k chunks, for the drill-down. Never full chunks. */
  retrieved: string[]
  /** `[start, end)` of each retrieved chunk, so the UI can highlight in place. */
  spans: [number, number][]
  /**
   * Where the answer actually ranked in the *whole* ranking, 1-based, or `null`
   * when no chunk in the document covers enough of it to count.
   *
   * Two numbers separate the two completely different reasons a config misses,
   * and `rr` alone collapses both to zero. `firstHitRank: 14` with `k: 5` says
   * the embedding found the passage and the retrieval depth threw it away — raise
   * `k`. `firstHitRank: null` says no chunk ever contained the answer, so the
   * chunker is at fault and `k` is irrelevant. Telling a reader which of those
   * they are looking at is the difference between a diagnostic and a scoreboard.
   */
  firstHitRank: number | null
  /**
   * Most of the gold answer any single chunk contained, 0–1, rounded to 3 dp.
   *
   * `null` only ever comes back from a permalink written before this was
   * recorded. Nullable rather than defaulted to zero because "no chunk covered
   * more than 0% of the answer" is a strong, specific claim, and inventing it for
   * a run that never measured it is precisely the fabricated number this whole
   * app exists to argue against.
   */
  bestOverlap: number | null
}

export interface ConfigResult {
  config: Config
  hitRate: number
  mrr: number
  chunkCount: number
  perQuestion: PerQuestionResult[]
}

export type Embedder = (texts: string[], model: string) => Promise<number[][]>

export interface VectorCache {
  get(key: string): Promise<number[][] | null>
  put(key: string, vectors: number[][]): Promise<void>
}

export interface RunDeps {
  embed?: Embedder
  /** `null` disables caching entirely — used by the determinism tests. */
  cache?: VectorCache | null
  /** Document content hash. Without it there is no stable cache key, so caching is skipped. */
  fingerprint?: string
  threshold?: number
  pageStarts?: number[]
  /** Cancels between configurations. Whatever finished is still returned. */
  signal?: AbortSignal
}

/**
 * A run that stopped partway, carrying the configurations that did finish.
 *
 * The alternative — rejecting with a bare error — throws away work the user
 * already paid to embed. Nine of twelve configurations completing is nine
 * genuine, comparable measurements; the honest thing is to show them and say
 * plainly that three are missing, not to blank the screen. What must not happen
 * is quietly presenting nine as though they were the whole comparison, so this
 * is an error and not a partial success: the caller has to handle it.
 */
export class BenchmarkFailure extends Error {
  constructor(
    message: string,
    readonly completed: ConfigResult[],
    readonly remaining: number,
  ) {
    super(message)
    this.name = 'BenchmarkFailure'
  }
}

/**
 * Twelve configurations is the ceiling.
 *
 * Not an arbitrary round number: twelve configs over a hundred-page document is
 * already ~3,600 embeddings and about ninety seconds of wall clock. Past that the
 * run stops being something a visitor waits for, and the leaderboard stops being
 * something a human can read.
 */
export const MAX_CONFIGS = 12

/** Characters per token. Crude, and close enough for a pre-run estimate on prose. */
const CHARS_PER_TOKEN = 4

export const EMBEDDING_MODELS: Record<string, { label: string; dims: number; usdPerMTok: number }> = {
  'text-embedding-3-small': { label: 'OpenAI 3-small', dims: 1536, usdPerMTok: 0.02 },
  'text-embedding-3-large': { label: 'OpenAI 3-large', dims: 3072, usdPerMTok: 0.13 },
}

/**
 * The human name of a configuration. One definition, used by the table, the
 * chart, the drill-down and the error messages, so a config a user reads about in
 * a failure is spelled exactly as it is in the leaderboard.
 */
export function configLabel(c: Config): string {
  const model = EMBEDDING_MODELS[c.model]?.label ?? c.model
  return `${chunkerLabel(c.chunker)} · ${c.size}/${c.overlap} · ${model} · k=${c.k}`
}

function describeFailure(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class MatrixTooLargeError extends Error {
  constructor(readonly count: number) {
    super(
      `That selection expands to ${count} configurations, above the cap of ${MAX_CONFIGS}. `
      + 'Deselect something — a truncated matrix would report a comparison you did not ask for.',
    )
    this.name = 'MatrixTooLargeError'
  }
}

function assertConfig(c: Config): void {
  if (!Number.isFinite(c.size) || c.size <= 0) {
    throw new RangeError(`Chunk size must be positive, got ${c.size}`)
  }
  if (c.overlap < 0 || c.overlap >= c.size) {
    throw new RangeError(`Overlap ${c.overlap} must be at least 0 and smaller than size ${c.size}`)
  }
  if (!Number.isInteger(c.k) || c.k <= 0) {
    throw new RangeError(`Top-k must be a positive integer, got ${c.k}`)
  }
  if (!(c.model in EMBEDDING_MODELS)) {
    throw new RangeError(
      `Unknown embedding model "${c.model}". Supported: ${Object.keys(EMBEDDING_MODELS).join(', ')}`,
    )
  }
}

/**
 * The cartesian product of the user's selection.
 *
 * Throws above `MAX_CONFIGS` instead of truncating. Truncation is the tempting
 * option and the wrong one: it silently drops configurations the user explicitly
 * asked for, then presents the survivors as though they were the whole
 * comparison — a benchmark that lies by omission.
 */
export function expandMatrix(sel: MatrixSelection): Config[] {
  if (sel.chunkers.length === 0) throw new RangeError('Select at least one chunker.')
  if (sel.sizes.length === 0) throw new RangeError('Select at least one chunk size.')
  if (sel.overlaps.length === 0) throw new RangeError('Select at least one overlap.')
  if (sel.models.length === 0) throw new RangeError('Select at least one embedding model.')
  if (sel.ks.length === 0) throw new RangeError('Select at least one k (top-k retrieval depth).')

  // A repeated value on any axis would spend one of the twelve slots on a row
  // identical to another, and give two leaderboard entries the same identity.
  const uniq = <T>(values: T[]): T[] => [...new Set(values)]

  const configs: Config[] = []
  for (const chunker of uniq(sel.chunkers)) {
    for (const size of uniq(sel.sizes)) {
      for (const overlap of uniq(sel.overlaps)) {
        for (const model of uniq(sel.models)) {
          for (const k of uniq(sel.ks)) {
            const config: Config = { chunker, size, overlap, model, k }
            assertConfig(config)
            configs.push(config)
          }
        }
      }
    }
  }

  if (configs.length > MAX_CONFIGS) throw new MatrixTooLargeError(configs.length)
  return configs
}

/** `expandMatrix` as a value instead of an exception, for render paths. */
export interface MatrixState {
  configs: Config[]
  error: string | null
  /** How many combinations to remove to get back under the cap. */
  overBy: number
}

/**
 * The one place a selection turns into configurations.
 *
 * Every consumer needs the same three things — the configs, the reason there are
 * none, and how far over the cap the user is — and expanding the matrix twice per
 * render to get them meant chunking the document twice for the cost estimate.
 */
export function matrixState(sel: MatrixSelection): MatrixState {
  try {
    return { configs: expandMatrix(sel), error: null, overBy: 0 }
  } catch (e) {
    return {
      configs: [],
      error: e instanceof Error ? e.message : String(e),
      overBy: e instanceof MatrixTooLargeError ? e.count - MAX_CONFIGS : 0,
    }
  }
}

/**
 * Projected embedding tokens and dollars for a matrix, before any money is spent.
 *
 * Counts the chunked text rather than the document, because overlap duplicates
 * characters and every duplicate is embedded and paid for — the single most
 * common surprise in a first RAG bill.
 */
export function estimateTokens(
  text: string,
  configs: Config[],
  questions: string[] = [],
): { tokens: number; usd: number } {
  let tokens = 0
  let usd = 0
  const questionChars = questions.reduce((n, q) => n + q.length, 0)
  const models = new Set(configs.map((c) => c.model))

  // Chunking a hundred-page document twelve times on every keystroke in the
  // matrix picker is a visible stall. Configs that differ only in model or k
  // share a chunking, so twelve estimates are usually three or four chunkings.
  const charsPerChunking = new Map<string, number>()

  for (const config of configs) {
    const shape = `${config.chunker}|${config.size}|${config.overlap}`
    let chars = charsPerChunking.get(shape)
    if (chars === undefined) {
      chars = chunkWith(config.chunker, text, { size: config.size, overlap: config.overlap })
        .reduce((n, c) => n + c.content.length, 0)
      charsPerChunking.set(shape, chars)
    }
    const configTokens = Math.ceil(chars / CHARS_PER_TOKEN)
    tokens += configTokens
    usd += (configTokens / 1_000_000) * (EMBEDDING_MODELS[config.model]?.usdPerMTok ?? 0)
  }

  // Questions are embedded once per model, not once per config.
  for (const model of models) {
    const t = Math.ceil(questionChars / CHARS_PER_TOKEN)
    tokens += t
    usd += (t / 1_000_000) * (EMBEDDING_MODELS[model]?.usdPerMTok ?? 0)
  }

  return { tokens, usd }
}

/** Cosine similarity. Returns 0 for a zero vector rather than NaN. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`Cosine dimension mismatch: ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Every chunk, ordered by cosine similarity to the query.
 *
 * Ties break on chunk index. Without that, `Array.prototype.sort` engine
 * differences could reorder equally-scoring chunks between runs and the
 * determinism guarantee would hold only by luck.
 *
 * The full ordering rather than the top `k`, because the diagnostic view needs to
 * know where the right answer landed when it landed past the cutoff — "rank 14 of
 * 60" and "nowhere in the document" are the same zero in the metrics and
 * completely different problems to fix.
 */
export function rankAll(chunks: SpanChunk[], vectors: number[][], query: number[]): SpanChunk[] {
  const scored = chunks.map((chunk, i) => ({ chunk, score: cosine(vectors[i] ?? [], query), i }))
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i))
  return scored.map((s) => s.chunk)
}

/** A question that some configuration cannot possibly answer, and why. */
export interface Unreachable {
  questionId: string
  /** Smallest chunk size at which a hit becomes arithmetically possible. */
  minSize: number
  /** The sizes in this matrix that are below it. */
  blockedSizes: number[]
}

/**
 * Questions no configuration in this matrix can ever hit, found before the run.
 *
 * A gold span of 900 characters cannot be half-covered by a 400-character chunk,
 * so every config at that size scores zero on it whatever the embedding does. The
 * run would report that as a retrieval failure and the reader would go and tune
 * the model. Saying so up front — while the matrix is still editable and before
 * any money is spent — is the single cheapest piece of teaching in the app.
 */
export function unreachableQuestions(
  questions: Question[],
  configs: Config[],
  threshold = DEFAULT_THRESHOLD,
): Unreachable[] {
  const sizes = [...new Set(configs.map((c) => c.size))].sort((a, b) => a - b)
  const out: Unreachable[] = []
  for (const q of questions) {
    const minSize = minChunkSizeToHit(q.gold, threshold)
    const blockedSizes = sizes.filter((s) => s < minSize)
    if (blockedSizes.length > 0) out.push({ questionId: q.id, minSize, blockedSizes })
  }
  return out
}

/** True when this config's chunk size makes a hit on this span impossible. */
export function isUnreachable(
  gold: GoldSpan,
  config: Config,
  threshold = DEFAULT_THRESHOLD,
): boolean {
  return config.size < minChunkSizeToHit(gold, threshold)
}

/** Excerpt length kept per retrieved chunk. Bounds what a permalink costs in Postgres. */
const EXCERPT_CHARS = 160

/**
 * How many retrieved excerpts survive into the persisted result.
 *
 * The full ranking is still recorded — `spans` covers every retrieved chunk at
 * about a dozen bytes each, and `rr` pins the exact rank of the first hit. Only
 * the human-readable text is truncated, because that is the part that scales:
 * twelve configs × fifteen questions × k=10 excerpts is ~300 KB, which alone
 * exceeds the 256 KB row budget that keeps this app inside its 30 MB slice of a
 * shared database. Three is what the drill-down actually shows before a reader
 * stops looking.
 */
const MAX_STORED_EXCERPTS = 3

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`
}

/**
 * One embedder per benchmark, not per call: the run identity it carries is what
 * makes a twelve-config run cost one unit of `raglab:runs` instead of twelve.
 * Lazily imported so the pure-logic tests never construct a Supabase client.
 */
async function defaultEmbedder(): Promise<Embedder> {
  const { createEmbedder } = await import('./embed')
  return createEmbedder()
}

/** The IndexedDB cache. Cheap to import — it has no dependencies of its own. */
const indexedDbCache: VectorCache = { get: getCached, put: putCached }

/**
 * Runs the whole comparison client-side and returns metrics only.
 *
 * What comes out of here is exactly what gets persisted for a permalink, so it
 * deliberately contains no vectors — only scores, excerpts and offsets. Vectors
 * stay in IndexedDB. That is the constraint the entire app is shaped around.
 */
export async function runBenchmark(
  text: string,
  questions: Question[],
  configs: Config[],
  onProgress: (done: number, total: number) => void,
  deps: RunDeps = {},
): Promise<ConfigResult[]> {
  if (questions.length === 0) throw new RangeError('A benchmark needs at least one question.')
  if (configs.length === 0) throw new RangeError('A benchmark needs at least one config.')
  if (configs.length > MAX_CONFIGS) throw new MatrixTooLargeError(configs.length)
  for (const config of configs) assertConfig(config)

  for (const q of questions) {
    // A label made against a slightly different revision of the document is the
    // dangerous case, because it does not look like an error: the offsets are
    // still in range, they just point at the wrong sentence now, and the run
    // completes and scores a passage nobody labelled. When the passage travelled
    // with the question we can say so exactly instead of guessing.
    if (q.goldText !== undefined && text.slice(q.gold.start, q.gold.end) !== q.goldText) {
      throw new RangeError(
        `Question "${q.id}" was labelled against different text. Its gold span now covers `
        + `${JSON.stringify(text.slice(q.gold.start, q.gold.end).slice(0, 60))} instead of `
        + `${JSON.stringify(q.goldText.slice(0, 60))}. Re-select the passage — scoring against `
        + 'drifted offsets produces numbers that look fine and mean nothing.',
      )
    }
    if (
      !Number.isInteger(q.gold.start) || !Number.isInteger(q.gold.end)
      || q.gold.start < 0 || q.gold.end > text.length || q.gold.start >= q.gold.end
    ) {
      throw new RangeError(
        `Question "${q.id}" has a gold span [${q.gold.start}, ${q.gold.end}) outside the document `
        + `(0–${text.length}). Gold offsets must index the same text the chunkers see.`,
      )
    }
  }

  const embed = deps.embed ?? await defaultEmbedder()
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD
  const cache = deps.cache === null
    ? null
    : (deps.cache ?? (deps.fingerprint ? indexedDbCache : null))
  const canCache = cache !== null && typeof deps.fingerprint === 'string'

  const results: ConfigResult[] = []
  const failed = (message: string) =>
    new BenchmarkFailure(message, results, configs.length - results.length)

  /** Rejects a response that does not line up one-to-one with what was sent. */
  const embedExactly = async (texts: string[], model: string, what: string) => {
    const vectors = quantize(await embed(texts, model))
    if (vectors.length !== texts.length) {
      throw failed(
        `The embedding service returned ${vectors.length} vectors for ${texts.length} ${what}. `
        + 'Scoring a misaligned batch would silently attribute every vector to the wrong text, '
        + 'so the run stops here.',
      )
    }
    const dim = vectors[0]?.length ?? 0
    if (vectors.some((v) => v.length !== dim)) {
      throw failed(`The embedding service returned ${what} of mixed dimension.`)
    }
    return vectors
  }

  // One question embedding per model, shared by every config using that model.
  // Doing this per config would multiply the cheapest part of the run by twelve.
  const questionVectors = new Map<string, number[][]>()
  const questionTexts = questions.map((q) => q.text)
  try {
    for (const model of new Set(configs.map((c) => c.model))) {
      questionVectors.set(model, await embedExactly(questionTexts, model, 'questions'))
    }
  } catch (e) {
    throw e instanceof BenchmarkFailure ? e : failed(describeFailure(e))
  }

  /**
   * Chunk vectors already computed in this run, keyed by model and by the exact
   * chunk boundaries.
   *
   * Two configurations can produce byte-identical chunkings — overlap does
   * nothing on a document whose paragraphs all fit inside one chunk, and
   * `recursive` and `sentence-window` coincide on unparagraphed text. Their cache
   * keys differ, because the key records the *settings*, so without this the same
   * embeddings get bought twice in the same run.
   */
  const withinRun = new Map<string, number[][]>()

  for (const config of configs) {
    if (deps.signal?.aborted) {
      throw failed(`Run cancelled after ${results.length} of ${configs.length} configurations.`)
    }

    const params = { size: config.size, overlap: config.overlap }
    const chunks = chunkWith(config.chunker, text, params, deps.pageStarts)
    const qv = questionVectors.get(config.model)!
    const shape = `${config.model} ${chunks.map((c) => `${c.start}:${c.end}`).join(',')}`

    let vectors = withinRun.get(shape) ?? null
    const key = canCache
      ? cacheKey(deps.fingerprint!, config.chunker, params, config.model)
      : null

    if (!vectors && key && cache) {
      const hit = await cache.get(key)
      // Reject an entry that cannot belong to this chunking: a different count
      // means it predates a chunker change, and a different dimension means the
      // model's output shape moved under a name that stayed the same. Either one
      // would otherwise surface as a raw "dimension mismatch" from `cosine`
      // halfway through a paid run.
      const usable = hit
        && hit.length === chunks.length
        && (hit.length === 0 || hit[0]!.length === (qv[0]?.length ?? hit[0]!.length))
      if (usable) vectors = hit
    }

    if (!vectors) {
      try {
        // `quantize` on the fresh path too: a cache hit returns float32 values, so
        // without this a warm run and a cold run could rank a near-tie differently.
        vectors = await embedExactly(chunks.map((c) => c.content), config.model, 'chunks')
      } catch (e) {
        throw e instanceof BenchmarkFailure
          ? e
          : failed(`${configLabel(config)} — ${describeFailure(e)}`)
      }
      if (key && cache) await cache.put(key, vectors)
    }
    withinRun.set(shape, vectors)

    const perQuestion: PerQuestionResult[] = questions.map((question, qi) => {
      const ordered = rankAll(chunks, vectors!, qv[qi]!)
      const ranked = ordered.slice(0, config.k)
      const rank = ordered.findIndex((c) => isHit(c, question.gold, threshold))
      const rr = reciprocalRank(ranked, question.gold, threshold)
      return {
        questionId: question.id,
        // Derived from `rr` rather than scanned again: two independent passes
        // over the same list can only ever disagree, never inform.
        hit: rr > 0,
        rr,
        retrieved: ranked.slice(0, MAX_STORED_EXCERPTS).map((c) => excerpt(c.content)),
        spans: ranked.map((c) => [c.start, c.end] as [number, number]),
        firstHitRank: rank === -1 ? null : rank + 1,
        bestOverlap: Math.round(bestOverlap(ordered, question.gold) * 1000) / 1000,
      }
    })

    results.push({
      config,
      ...aggregate(perQuestion),
      chunkCount: chunks.length,
      perQuestion,
    })
    onProgress(results.length, configs.length)
  }

  return results
}
