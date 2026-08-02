import { describe, it, expect, vi } from 'vitest'
import { SAMPLE_DOC, SAMPLE_QUESTIONS } from '../samples/founding-documents'
import type { Question } from './metrics'
import { MAX_RESULTS_BYTES, assertNoVectors } from './persist'
import {
  MAX_CONFIGS,
  MatrixTooLargeError,
  cosine,
  estimateTokens,
  expandMatrix,
  rankChunks,
  runBenchmark,
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

describe('rankChunks', () => {
  const chunks = [
    { content: 'a', page: 1, index: 0, start: 0, end: 1 },
    { content: 'b', page: 1, index: 1, start: 1, end: 2 },
    { content: 'c', page: 1, index: 2, start: 2, end: 3 },
  ]
  const vectors = [[1, 0], [0, 1], [0.9, 0.1]]

  it('orders by descending similarity', () => {
    expect(rankChunks(chunks, vectors, [1, 0], 3).map((c) => c.content)).toEqual(['a', 'c', 'b'])
  })

  it('truncates to k', () => {
    expect(rankChunks(chunks, vectors, [1, 0], 2)).toHaveLength(2)
  })

  it('breaks ties by chunk index so the order is reproducible', () => {
    const tied = [[1, 0], [1, 0], [1, 0]]
    expect(rankChunks(chunks, tied, [1, 0], 3).map((c) => c.index)).toEqual([0, 1, 2])
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
})
