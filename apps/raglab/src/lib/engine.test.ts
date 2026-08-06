import { describe, it, expect, vi } from 'vitest'
import { SAMPLE_DOC, SAMPLE_QUESTIONS } from '../samples/founding-documents'
import type { Question } from './metrics'
import { MAX_RESULTS_BYTES, assertNoVectors } from './persist'
import {
  BenchmarkFailure,
  MAX_CONFIGS,
  MatrixTooLargeError,
  cosine,
  estimateTokens,
  expandMatrix,
  isUnreachable,
  matrixState,
  rankAll,
  runBenchmark,
  unreachableQuestions,
  type Config,
  type Embedder,
} from './engine'

const SMALL = 'text-embedding-3-small'
const LARGE = 'text-embedding-3-large'

const doc = [
  'The mitochondrion is the powerhouse of the cell. It generates most of the '
    + 'chemical energy needed to power biochemical reactions.',
  '',
  'Chloroplasts conduct photosynthesis in plant cells. They capture light energy '
    + 'and convert it into chemical energy stored in sugars.',
  '',
  'The ribosome assembles proteins from amino acids. It reads messenger RNA and '
    + 'links the residues in the encoded order.',
].join('\n')

const questions: Question[] = [
  {
    id: 'q1',
    text: 'What does the mitochondrion do?',
    gold: { start: doc.indexOf('The mitochondrion'), end: doc.indexOf('. It generates') + 1 },
  },
  {
    id: 'q2',
    text: 'What do chloroplasts do?',
    gold: { start: doc.indexOf('Chloroplasts'), end: doc.indexOf('. They capture') + 1 },
  },
  {
    id: 'q3',
    text: 'What does the ribosome do?',
    gold: { start: doc.indexOf('The ribosome'), end: doc.indexOf('. It reads') + 1 },
  },
]

/**
 * A deterministic stand-in for OpenAI: a bag-of-words vector over a fixed
 * vocabulary. Real enough that relevant chunks actually rank first, and pure
 * enough that a second run must produce identical numbers.
 */
const VOCAB = [
  'mitochondrion', 'powerhouse', 'energy', 'chloroplast', 'chloroplasts',
  'photosynthesis', 'light', 'ribosome', 'protein', 'proteins', 'rna', 'cell', 'cells',
]

function makeStubEmbedder(): Embedder & { calls: () => number; texts: () => string[] } {
  let calls = 0
  const seen: string[] = []
  const fn = async (texts: string[], model: string): Promise<number[][]> => {
    calls++
    seen.push(...texts)
    const scale = model === LARGE ? 1.5 : 1
    return texts.map((t) => {
      const lower = t.toLowerCase()
      const v = VOCAB.map((w) => (lower.includes(w) ? 1 : 0))
      // Keeps the vector non-zero for chunks with no vocabulary hit at all.
      return [...v.map((x) => x * scale), 0.01]
    })
  }
  return Object.assign(fn, { calls: () => calls, texts: () => seen })
}

const noProgress = () => {}

describe('expandMatrix', () => {
  it('produces the cartesian product', () => {
    const configs = expandMatrix({
      chunkers: ['fixed', 'recursive'],
      sizes: [400, 800],
      overlaps: [0],
      models: [SMALL],
      ks: [3],
    })
    expect(configs).toHaveLength(4)
    expect(configs[0]).toEqual({ chunker: 'fixed', size: 400, overlap: 0, model: SMALL, k: 3 })
  })

  it('is deterministic in ordering', () => {
    const sel = {
      chunkers: ['recursive', 'fixed'] as const,
      sizes: [800, 400],
      overlaps: [0, 80],
      models: [SMALL],
      ks: [5],
    }
    expect(expandMatrix({ ...sel, chunkers: [...sel.chunkers] }))
      .toEqual(expandMatrix({ ...sel, chunkers: [...sel.chunkers] }))
  })

  it('allows exactly the cap', () => {
    const configs = expandMatrix({
      chunkers: ['fixed', 'sentence-window', 'recursive'],
      sizes: [400, 800],
      overlaps: [0, 80],
      models: [SMALL],
      ks: [5],
    })
    expect(configs).toHaveLength(MAX_CONFIGS)
  })

  // Truncating would quietly drop the configurations a user explicitly selected
  // and then present the survivors as if they were the whole comparison.
  it('throws above the cap rather than silently truncating', () => {
    const oversized = () =>
      expandMatrix({
        chunkers: ['fixed', 'sentence-window', 'recursive'],
        sizes: [400, 800],
        overlaps: [0, 80],
        models: [SMALL, LARGE],
        ks: [5],
      })
    expect(oversized).toThrow(MatrixTooLargeError)
    expect(oversized).toThrow(/24/)
    expect(oversized).toThrow(new RegExp(String(MAX_CONFIGS)))
  })

  it('throws when a dimension is empty instead of returning nothing', () => {
    expect(() =>
      expandMatrix({ chunkers: [], sizes: [400], overlaps: [0], models: [SMALL], ks: [3] }),
    ).toThrow(/chunker/i)
    expect(() =>
      expandMatrix({ chunkers: ['fixed'], sizes: [400], overlaps: [0], models: [SMALL], ks: [] }),
    ).toThrow(/k/i)
  })

  it('rejects an overlap that is not smaller than the size', () => {
    expect(() =>
      expandMatrix({
        chunkers: ['fixed'], sizes: [400], overlaps: [400], models: [SMALL], ks: [3],
      }),
    ).toThrow(/overlap/i)
  })

  it('rejects an unknown embedding model', () => {
    expect(() =>
      expandMatrix({
        chunkers: ['fixed'], sizes: [400], overlaps: [0], models: ['text-embedding-ada-002'], ks: [3],
      }),
    ).toThrow(/model/i)
  })

  // A repeated value would spend one of the twelve slots on a duplicate row and
  // give two leaderboard entries the same identity.
  it('collapses a repeated value on an axis instead of duplicating a config', () => {
    const configs = expandMatrix({
      chunkers: ['fixed', 'fixed'],
      sizes: [400, 400, 800],
      overlaps: [0],
      models: [SMALL],
      ks: [3, 3],
    })
    expect(configs).toHaveLength(2)
    expect(new Set(configs.map((c) => JSON.stringify(c))).size).toBe(2)
  })

  it('does not let duplicates push a legal selection over the cap', () => {
    expect(() =>
      expandMatrix({
        chunkers: ['fixed', 'sentence-window', 'recursive', 'fixed'],
        sizes: [400, 800, 400],
        overlaps: [0, 80, 0],
        models: [SMALL, SMALL],
        ks: [5],
      }),
    ).not.toThrow()
  })
})

describe('matrixState', () => {
  it('reports the configs when the selection is legal', () => {
    const state = matrixState({
      chunkers: ['fixed'], sizes: [400], overlaps: [0], models: [SMALL], ks: [5],
    })
    expect(state).toEqual({ configs: [
      { chunker: 'fixed', size: 400, overlap: 0, model: SMALL, k: 5 },
    ], error: null, overBy: 0 })
  })

  it('reports how far over the cap the selection is', () => {
    const state = matrixState({
      chunkers: ['fixed', 'sentence-window', 'recursive'],
      sizes: [400, 800],
      overlaps: [0, 80],
      models: [SMALL, LARGE],
      ks: [5],
    })
    expect(state.configs).toEqual([])
    expect(state.overBy).toBe(24 - MAX_CONFIGS)
    expect(state.error).toMatch(/24/)
  })

  it('reports an empty axis as an error and not as an over-cap count', () => {
    const state = matrixState({
      chunkers: [], sizes: [400], overlaps: [0], models: [SMALL], ks: [5],
    })
    expect(state.error).toMatch(/chunker/i)
    expect(state.overBy).toBe(0)
  })
})

describe('unreachableQuestions', () => {
  const long = { id: 'long', text: 'q', gold: { start: 0, end: 900 } }
  const short = { id: 'short', text: 'q', gold: { start: 0, end: 100 } }
  const at = (size: number): Config => ({ chunker: 'fixed', size, overlap: 0, model: SMALL, k: 5 })

  // No chunker emits a chunk larger than its size, so a 400-character chunk
  // cannot cover half of a 900-character answer. That zero is arithmetic, not
  // retrieval, and reporting it as a miss sends the reader off tuning the model.
  it('flags a gold span more than twice the chunk size', () => {
    const [u] = unreachableQuestions([long, short], [at(400)])
    expect(u!.questionId).toBe('long')
    expect(u!.minSize).toBe(450)
    expect(u!.blockedSizes).toEqual([400])
  })

  it('says nothing when the largest size in the matrix can reach it', () => {
    expect(unreachableQuestions([long], [at(400), at(800)])[0]?.blockedSizes).toEqual([400])
    expect(unreachableQuestions([long], [at(800), at(1600)])).toEqual([])
  })

  it('agrees with what the run actually scores', async () => {
    const [tooSmall, bigEnough] = await runBenchmark(
      doc,
      [{ id: 'q1', text: 'What does the mitochondrion do?', gold: { start: 0, end: 120 } }],
      [
        { chunker: 'fixed', size: 40, overlap: 0, model: SMALL, k: 10 },
        { chunker: 'fixed', size: 120, overlap: 0, model: SMALL, k: 10 },
      ],
      noProgress,
      { embed: makeStubEmbedder(), cache: null },
    )
    expect(isUnreachable({ start: 0, end: 120 }, tooSmall!.config)).toBe(true)
    expect(tooSmall!.perQuestion[0]!.firstHitRank).toBeNull()
    expect(isUnreachable({ start: 0, end: 120 }, bigEnough!.config)).toBe(false)
    expect(bigEnough!.perQuestion[0]!.firstHitRank).not.toBeNull()
  })
})

describe('estimateTokens', () => {
  const configs: Config[] = [
    { chunker: 'fixed', size: 400, overlap: 0, model: SMALL, k: 3 },
    { chunker: 'fixed', size: 400, overlap: 200, model: LARGE, k: 3 },
  ]

  it('is deterministic', () => {
    expect(estimateTokens(doc, configs)).toEqual(estimateTokens(doc, configs))
  })

  it('scales with the number of configs', () => {
    const one = estimateTokens(doc, [configs[0]!])
    const two = estimateTokens(doc, configs)
    expect(two.tokens).toBeGreaterThan(one.tokens)
  })

  it('charges more tokens for overlapping chunks than for disjoint ones', () => {
    // Overlap duplicates text across chunks, and every duplicate is embedded.
    const disjoint = estimateTokens(doc, [
      { chunker: 'fixed', size: 120, overlap: 0, model: SMALL, k: 3 },
    ])
    const overlapping = estimateTokens(doc, [
      { chunker: 'fixed', size: 120, overlap: 60, model: SMALL, k: 3 },
    ])
    expect(overlapping.tokens).toBeGreaterThan(disjoint.tokens)
  })

  it('prices the large model above the small one for the same work', () => {
    const small = estimateTokens(doc, [
      { chunker: 'fixed', size: 400, overlap: 0, model: SMALL, k: 3 },
    ])
    const large = estimateTokens(doc, [
      { chunker: 'fixed', size: 400, overlap: 0, model: LARGE, k: 3 },
    ])
    expect(large.tokens).toBe(small.tokens)
    expect(large.usd).toBeGreaterThan(small.usd)
  })

  it('returns zero for no configs', () => {
    expect(estimateTokens(doc, [])).toEqual({ tokens: 0, usd: 0 })
  })
})

describe('cosine', () => {
  it('is 1 for identical directions regardless of magnitude', () => {
    expect(cosine([1, 0, 0], [4, 0, 0])).toBeCloseTo(1)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('is -1 for opposed vectors', () => {
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1)
  })

  it('is 0 rather than NaN for a zero vector', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it('throws on a dimension mismatch instead of scoring a prefix', () => {
    expect(() => cosine([1, 2, 3], [1, 2])).toThrow(/dimension/i)
  })
})

describe('rankAll', () => {
  const chunks = [
    { content: 'a', page: 1, index: 0, start: 0, end: 1 },
    { content: 'b', page: 1, index: 1, start: 1, end: 2 },
    { content: 'c', page: 1, index: 2, start: 2, end: 3 },
  ]
  const vectors = [[1, 0], [0, 1], [0.9, 0.1]]

  it('orders by descending similarity', () => {
    expect(rankAll(chunks, vectors, [1, 0]).map((c) => c.content)).toEqual(['a', 'c', 'b'])
  })

  it('returns the whole list, not a cutoff', () => {
    // The diagnostic view needs to know the answer ranked #14 of 60. Truncating
    // here would make "past k" and "absent from the document" the same result.
    expect(rankAll(chunks, vectors, [1, 0])).toHaveLength(chunks.length)
  })

  it('breaks ties by chunk index so the order is reproducible', () => {
    const tied = [[1, 0], [1, 0], [1, 0]]
    expect(rankAll(chunks, tied, [1, 0]).map((c) => c.index)).toEqual([0, 1, 2])
  })
})

describe('runBenchmark', () => {
  const configs: Config[] = [
    { chunker: 'fixed', size: 120, overlap: 0, model: SMALL, k: 2 },
    { chunker: 'sentence-window', size: 120, overlap: 0, model: SMALL, k: 2 },
  ]

  it('scores every config against every question', async () => {
    const results = await runBenchmark(doc, questions, configs, noProgress, {
      embed: makeStubEmbedder(),
      cache: null,
    })
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.perQuestion).toHaveLength(3)
      expect(r.hitRate).toBeGreaterThanOrEqual(0)
      expect(r.hitRate).toBeLessThanOrEqual(1)
      expect(r.mrr).toBeGreaterThan(0)
    }
  })

  // The whole tool is worthless if a benchmark is not reproducible: a permalink
  // that scores differently on reload is not evidence of anything.
  it('reproduces identical scores on a second identical run', async () => {
    const first = await runBenchmark(doc, questions, configs, noProgress, {
      embed: makeStubEmbedder(),
      cache: null,
    })
    const second = await runBenchmark(doc, questions, configs, noProgress, {
      embed: makeStubEmbedder(),
      cache: null,
    })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('produces identical scores whether or not the cache is warm', async () => {
    const store = new Map<string, number[][]>()
    const memoryCache = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: number[][]) => void store.set(k, v),
    }
    const cold = await runBenchmark(doc, questions, configs, noProgress, {
      embed: makeStubEmbedder(),
      cache: memoryCache,
      fingerprint: 'fp',
    })
    expect(store.size).toBe(2)
    const warm = await runBenchmark(doc, questions, configs, noProgress, {
      embed: makeStubEmbedder(),
      cache: memoryCache,
      fingerprint: 'fp',
    })
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold))
  })

  it('skips embedding entirely on a warm cache', async () => {
    const store = new Map<string, number[][]>()
    const memoryCache = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: number[][]) => void store.set(k, v),
    }
    const one = [configs[0]!]
    await runBenchmark(doc, questions, one, noProgress, {
      embed: makeStubEmbedder(), cache: memoryCache, fingerprint: 'fp',
    })
    const warm = makeStubEmbedder()
    await runBenchmark(doc, questions, one, noProgress, {
      embed: warm, cache: memoryCache, fingerprint: 'fp',
    })
    // Questions still need embedding; the document does not.
    expect(warm.texts()).toEqual(questions.map((q) => q.text))
  })

  it('embeds each question set once per model, not once per config', async () => {
    const embed = makeStubEmbedder()
    await runBenchmark(
      doc,
      questions,
      [
        { chunker: 'fixed', size: 120, overlap: 0, model: SMALL, k: 2 },
        { chunker: 'recursive', size: 120, overlap: 0, model: SMALL, k: 2 },
        { chunker: 'fixed', size: 240, overlap: 0, model: SMALL, k: 2 },
      ],
      noProgress,
      { embed, cache: null },
    )
    const questionEmbeddings = embed.texts().filter((t) => t === questions[0]!.text)
    expect(questionEmbeddings).toHaveLength(1)
  })

  it('ranks the correct passage first for an easy question', async () => {
    const [result] = await runBenchmark(
      doc,
      [questions[1]!],
      [{ chunker: 'recursive', size: 200, overlap: 0, model: SMALL, k: 3 }],
      noProgress,
      { embed: makeStubEmbedder(), cache: null },
    )
    expect(result!.perQuestion[0]!.rr).toBe(1)
    expect(result!.perQuestion[0]!.retrieved[0]).toMatch(/Chloroplasts/)
  })

  it('reports progress once per config, ending at total', async () => {
    const onProgress = vi.fn()
    await runBenchmark(doc, questions, configs, onProgress, {
      embed: makeStubEmbedder(),
      cache: null,
    })
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith(2, 2)
  })

  it('never returns a vector anywhere in its results', async () => {
    // The single hardest constraint in this app: whatever comes out of here is
    // what gets written to Postgres, and Postgres must never see an embedding.
    const results = await runBenchmark(doc, questions, configs, noProgress, {
      embed: makeStubEmbedder(),
      cache: null,
    })
    const json = JSON.stringify(results)
    expect(json.length).toBeLessThan(50_000)
    expect(/\[(-?\d+\.\d+,){100,}/.test(json)).toBe(false)
  })

  // The persisted payload has to fit the 256 KB row budget at the *worst* legal
  // run, not the demo one: twelve configs, fifteen questions, k=10. Getting this
  // wrong means the guard rejects a run the UI happily let the user pay for.
  it('fits the persistence budget at the largest run the caps allow', async () => {
    const maxConfigs = expandMatrix({
      chunkers: ['fixed', 'sentence-window', 'recursive'],
      sizes: [200, 400],
      overlaps: [0, 40],
      models: [SMALL],
      ks: [10],
    })
    expect(maxConfigs).toHaveLength(MAX_CONFIGS)

    const results = await runBenchmark(
      SAMPLE_DOC.text,
      SAMPLE_QUESTIONS,
      maxConfigs,
      noProgress,
      { embed: makeStubEmbedder(), cache: null },
    )
    expect(results[0]!.perQuestion[0]!.spans).toHaveLength(10)
    expect(() => assertNoVectors(results)).not.toThrow()
    expect(JSON.stringify(results).length).toBeLessThan(MAX_RESULTS_BYTES)
  })

  it('keeps the full ranking in spans even when excerpts are truncated', async () => {
    const [result] = await runBenchmark(
      SAMPLE_DOC.text,
      SAMPLE_QUESTIONS.slice(0, 2),
      [{ chunker: 'fixed', size: 200, overlap: 0, model: SMALL, k: 8 }],
      noProgress,
      { embed: makeStubEmbedder(), cache: null },
    )
    const outcome = result!.perQuestion[0]!
    expect(outcome.spans).toHaveLength(8)
    expect(outcome.retrieved.length).toBeLessThanOrEqual(3)
  })

  it('refuses to run with no questions', async () => {
    await expect(
      runBenchmark(doc, [], configs, noProgress, { embed: makeStubEmbedder(), cache: null }),
    ).rejects.toThrow(/question/i)
  })

  it('refuses to run with no configs', async () => {
    await expect(
      runBenchmark(doc, questions, [], noProgress, { embed: makeStubEmbedder(), cache: null }),
    ).rejects.toThrow(/config/i)
  })

  it('refuses to run above the config cap', async () => {
    const many = Array.from({ length: MAX_CONFIGS + 1 }, (_, i) => ({
      chunker: 'fixed' as const, size: 100 + i, overlap: 0, model: SMALL, k: 2,
    }))
    await expect(
      runBenchmark(doc, questions, many, noProgress, { embed: makeStubEmbedder(), cache: null }),
    ).rejects.toThrow(MatrixTooLargeError)
  })

  it('rejects a gold span that does not fit the document', async () => {
    await expect(
      runBenchmark(
        doc,
        [{ id: 'bad', text: 'x', gold: { start: 0, end: doc.length + 10 } }],
        configs,
        noProgress,
        { embed: makeStubEmbedder(), cache: null },
      ),
    ).rejects.toThrow(/gold/i)
  })

  // The out-of-range case above announces itself. This one does not: the offsets
  // are still valid, they just point at a different sentence than the one that
  // was labelled, and the run completes and scores a passage nobody chose.
  it('refuses labels made against a different revision of the document', async () => {
    const gold = { start: 0, end: 46 }
    const labelled = { id: 'q1', text: 'x', gold, goldText: doc.slice(0, 46) }

    // Same document: fine.
    await expect(
      runBenchmark(doc, [labelled], configs, noProgress, {
        embed: makeStubEmbedder(), cache: null,
      }),
    ).resolves.toHaveLength(configs.length)

    // Two words inserted near the top shift every offset after them.
    const edited = doc.replace('The mitochondrion', 'In animal cells the mitochondrion')
    await expect(
      runBenchmark(edited, [labelled], configs, noProgress, {
        embed: makeStubEmbedder(), cache: null,
      }),
    ).rejects.toThrow(/labelled against different text/i)
  })

  it('still runs labels that carry no passage, since old permalinks have none', async () => {
    await expect(
      runBenchmark(doc, questions, configs, noProgress, {
        embed: makeStubEmbedder(), cache: null,
      }),
    ).resolves.toHaveLength(configs.length)
  })
})

describe('diagnostic fields', () => {
  const config = (k: number): Config => ({
    chunker: 'fixed', size: 60, overlap: 0, model: SMALL, k,
  })

  it('reports where the answer ranked even when k threw it away', async () => {
    // The stub knows no constitutional vocabulary, so every chunk scores the
    // same and the ranking falls back to document order — a uniform embedding
    // that finds every answer and buries most of them. Exactly the case where
    // `rr` reports zero and the reason is the cutoff, not the retrieval.
    const shape = { chunker: 'fixed' as const, size: 400, overlap: 0, model: SMALL }
    const [deep, shallow] = await runBenchmark(
      SAMPLE_DOC.text, SAMPLE_QUESTIONS,
      [{ ...shape, k: 20 }, { ...shape, k: 1 }],
      noProgress, { embed: makeStubEmbedder(), cache: null },
    )

    // Same chunking and same vectors, so the rank of the answer cannot depend on k.
    for (let i = 0; i < SAMPLE_QUESTIONS.length; i++) {
      expect(shallow!.perQuestion[i]!.firstHitRank).toBe(deep!.perQuestion[i]!.firstHitRank)
    }

    const cutOff = shallow!.perQuestion.filter(
      (p) => !p.hit && p.firstHitRank !== null && p.firstHitRank > 1,
    )
    expect(cutOff.length).toBeGreaterThan(0)
    // Every one of those would be a hit at a deep enough k, which is the whole
    // point of recording the rank: the fix is a bigger k, not a better model.
    for (const p of cutOff) expect(deep!.perQuestion.find((d) => d.questionId === p.questionId)!.hit)
      .toBe(p.firstHitRank! <= 20)
  })

  it('keeps hit, rr and firstHitRank mutually consistent', async () => {
    for (const k of [1, 3, 10]) {
      const [r] = await runBenchmark(doc, questions, [config(k)], noProgress, {
        embed: makeStubEmbedder(), cache: null,
      })
      for (const p of r!.perQuestion) {
        expect(p.hit).toBe(p.rr > 0)
        expect(p.hit).toBe(p.firstHitRank !== null && p.firstHitRank <= k)
        if (p.hit) expect(p.rr).toBeCloseTo(1 / p.firstHitRank!)
      }
    }
  })

  it('separates "no chunk held the answer" from "the answer ranked low"', async () => {
    // A gold span wider than any chunk can cover: no rank exists at all, and
    // bestOverlap says how close the chunker came.
    const gold = { start: 0, end: 260 }
    const [r] = await runBenchmark(
      doc, [{ id: 'wide', text: 'What does the mitochondrion do?', gold }],
      [{ chunker: 'fixed', size: 60, overlap: 0, model: SMALL, k: 10 }],
      noProgress, { embed: makeStubEmbedder(), cache: null },
    )
    const p = r!.perQuestion[0]!
    expect(p.firstHitRank).toBeNull()
    expect(p.bestOverlap).toBeGreaterThan(0)
    expect(p.bestOverlap).toBeLessThan(0.5)
  })
})

describe('runtime failures', () => {
  const configs: Config[] = [
    { chunker: 'fixed', size: 120, overlap: 0, model: SMALL, k: 2 },
    { chunker: 'fixed', size: 240, overlap: 0, model: SMALL, k: 2 },
    { chunker: 'recursive', size: 120, overlap: 0, model: SMALL, k: 2 },
  ]

  /** Wraps a good embedder and breaks on the nth call. */
  function breakingAfter(n: number): Embedder {
    const good = makeStubEmbedder()
    let calls = 0
    return async (texts, model) => {
      if (++calls > n) throw new Error('502 from the embedding proxy')
      return good(texts, model)
    }
  }

  // Nine of twelve configurations completing is nine genuine measurements the
  // user already paid to embed. Rejecting with a bare error throws them away.
  it('returns the configurations that finished when a later one fails', async () => {
    // Call 1 embeds the questions; calls 2 and 3 are the first two configs.
    const error = await runBenchmark(doc, questions, configs, noProgress, {
      embed: breakingAfter(3), cache: null,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BenchmarkFailure)
    const failure = error as BenchmarkFailure
    expect(failure.completed).toHaveLength(2)
    expect(failure.remaining).toBe(1)
    expect(failure.message).toMatch(/502/)
    // And the survivors are complete, scoreable results — not half-filled ones.
    for (const r of failure.completed) expect(r.perQuestion).toHaveLength(questions.length)
  })

  it('fails with nothing completed when the question set itself cannot be embedded', async () => {
    const error = await runBenchmark(doc, questions, configs, noProgress, {
      embed: breakingAfter(0), cache: null,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BenchmarkFailure)
    expect((error as BenchmarkFailure).completed).toEqual([])
  })

  it('stops on cancellation and keeps what finished', async () => {
    const controller = new AbortController()
    const error = await runBenchmark(
      doc, questions, configs,
      (done) => { if (done === 1) controller.abort() },
      { embed: makeStubEmbedder(), cache: null, signal: controller.signal },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BenchmarkFailure)
    expect((error as BenchmarkFailure).completed).toHaveLength(1)
    expect((error as BenchmarkFailure).message).toMatch(/cancelled/i)
  })

  // A short response would leave `vectors[i]` undefined and score every chunk
  // after the gap against an empty vector; a long one would silently shift the
  // whole alignment. Both must stop the run, not produce numbers.
  it('refuses a response with the wrong number of vectors', async () => {
    for (const delta of [-1, 1]) {
      const good = makeStubEmbedder()
      const skewed: Embedder = async (texts, model) => {
        const vectors = await good(texts, model)
        return delta < 0 ? vectors.slice(0, -1) : [...vectors, vectors[0]!]
      }
      const error = await runBenchmark(doc, questions, [configs[0]!], noProgress, {
        embed: skewed, cache: null,
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(BenchmarkFailure)
      expect((error as Error).message).toMatch(/misaligned|vectors for/i)
    }
  })

  it('refuses a response whose vectors are not all the same width', async () => {
    const good = makeStubEmbedder()
    const ragged: Embedder = async (texts, model) => {
      const vectors = await good(texts, model)
      return vectors.map((v, i) => (i === 1 ? v.slice(0, 3) : v))
    }
    await expect(
      runBenchmark(doc, questions, [configs[0]!], noProgress, { embed: ragged, cache: null }),
    ).rejects.toThrow(/dimension/i)
  })

  // A cached entry whose width no longer matches the question vectors would
  // surface as a raw "dimension mismatch" out of `cosine`, halfway through a run
  // the user is already paying for. Treat it as a miss and re-embed.
  it('ignores a cache entry that cannot belong to this chunking', async () => {
    const store = new Map<string, number[][]>()
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: number[][]) => void store.set(k, v),
    }
    const clean = await runBenchmark(doc, questions, [configs[0]!], noProgress, {
      embed: makeStubEmbedder(), cache, fingerprint: 'fp',
    })

    for (const [k, v] of store) store.set(k, v.map((row) => row.slice(0, 4)))
    const afterCorruption = await runBenchmark(doc, questions, [configs[0]!], noProgress, {
      embed: makeStubEmbedder(), cache, fingerprint: 'fp',
    })
    expect(JSON.stringify(afterCorruption)).toBe(JSON.stringify(clean))
  })

  it('ignores a cache entry with the wrong number of vectors', async () => {
    const store = new Map<string, number[][]>()
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: number[][]) => void store.set(k, v),
    }
    const clean = await runBenchmark(doc, questions, [configs[0]!], noProgress, {
      embed: makeStubEmbedder(), cache, fingerprint: 'fp',
    })
    for (const [k, v] of store) store.set(k, v.slice(0, 1))
    const after = await runBenchmark(doc, questions, [configs[0]!], noProgress, {
      embed: makeStubEmbedder(), cache, fingerprint: 'fp',
    })
    expect(JSON.stringify(after)).toBe(JSON.stringify(clean))
  })

  // Two configurations can chunk a document identically — overlap does nothing
  // when every paragraph already fits, and `recursive` matches `sentence-window`
  // on text with no paragraph breaks. Their cache keys differ, because a key
  // records the settings rather than the result, so without a within-run memo the
  // same embeddings are bought twice in the same run.
  it('embeds an identical chunking once even under two different config names', async () => {
    const flat = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu. '
      + 'Nu xi omicron pi. Rho sigma tau upsilon.'
    const pair: Config[] = [
      { chunker: 'sentence-window', size: 50, overlap: 0, model: SMALL, k: 2 },
      { chunker: 'recursive', size: 50, overlap: 0, model: SMALL, k: 2 },
    ]
    const question = [{ id: 'q1', text: 'alpha beta', gold: { start: 0, end: 23 } }]

    const embed = makeStubEmbedder()
    const [a, b] = await runBenchmark(flat, question, pair, noProgress, { embed, cache: null })
    expect(a!.chunkCount).toBe(b!.chunkCount)
    expect(a!.perQuestion).toEqual(b!.perQuestion)
    // One call for the questions, one for the shared chunking. Not two.
    expect(embed.calls()).toBe(2)
  })
})
