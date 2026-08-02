import { chunkWith, type ChunkerId, type SpanChunk } from './chunkers'
import { cacheKey, getCached, putCached, quantize } from './cache'
import {
  DEFAULT_THRESHOLD,
  aggregate,
  isHit,
  reciprocalRank,
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

  const configs: Config[] = []
  for (const chunker of sel.chunkers) {
    for (const size of sel.sizes) {
      for (const overlap of sel.overlaps) {
        for (const model of sel.models) {
          for (const k of sel.ks) {
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

  for (const config of configs) {
    const chars = chunkWith(config.chunker, text, { size: config.size, overlap: config.overlap })
      .reduce((n, c) => n + c.content.length, 0)
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
 * Top-k chunks by cosine similarity to the query.
 *
 * Ties break on chunk index. Without that, `Array.prototype.sort` engine
 * differences could reorder equally-scoring chunks between runs and the
 * determinism guarantee would hold only by luck.
 */
export function rankChunks(
  chunks: SpanChunk[],
  vectors: number[][],
  query: number[],
  k: number,
): SpanChunk[] {
  const scored = chunks.map((chunk, i) => ({ chunk, score: cosine(vectors[i] ?? [], query), i }))
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i))
  return scored.slice(0, Math.max(0, k)).map((s) => s.chunk)
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

  // One question embedding per model, shared by every config using that model.
  // Doing this per config would multiply the cheapest part of the run by twelve.
  const questionVectors = new Map<string, number[][]>()
  for (const model of new Set(configs.map((c) => c.model))) {
    questionVectors.set(model, quantize(await embed(questions.map((q) => q.text), model)))
  }

  const results: ConfigResult[] = []
  for (const config of configs) {
    const params = { size: config.size, overlap: config.overlap }
    const chunks = chunkWith(config.chunker, text, params, deps.pageStarts)

    let vectors: number[][] | null = null
    const key = canCache
      ? cacheKey(deps.fingerprint!, config.chunker, params, config.model)
      : null

    if (key && cache) {
      const hit = await cache.get(key)
      // A length mismatch means the entry predates a chunker change; treat as a miss.
      if (hit && hit.length === chunks.length) vectors = hit
    }

    if (!vectors) {
      // `quantize` on the fresh path too: a cache hit returns float32 values, so
      // without this a warm run and a cold run could rank a near-tie differently.
      vectors = quantize(await embed(chunks.map((c) => c.content), config.model))
      if (key && cache) await cache.put(key, vectors)
    }

    const qv = questionVectors.get(config.model)!
    const perQuestion: PerQuestionResult[] = questions.map((question, qi) => {
      const ranked = rankChunks(chunks, vectors!, qv[qi]!, config.k)
      return {
        questionId: question.id,
        hit: ranked.some((c) => isHit(c, question.gold, threshold)),
        rr: reciprocalRank(ranked, question.gold, threshold),
        retrieved: ranked.slice(0, MAX_STORED_EXCERPTS).map((c) => excerpt(c.content)),
        spans: ranked.map((c) => [c.start, c.end] as [number, number]),
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
