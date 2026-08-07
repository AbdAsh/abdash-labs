#!/usr/bin/env node
/**
 * Records the bundled "finished example" by running a real benchmark against the
 * deployed `raglab-embed` function.
 *
 *     SUPABASE_ANON_KEY=... node apps/raglab/scripts/record-example.mjs
 *
 * Why this exists. A benchmark over the sample takes most of a minute and spends
 * one of an anonymous visitor's two daily runs, and a reviewer will not wait. So
 * the app opens on a finished result instead. The only honest way to ship that
 * result is to measure it: this script drives the same `runBenchmark`, the same
 * `createEmbedder`, and the same live Edge Function the browser does, and writes
 * exactly what came back. Nothing in `src/example/` is written by hand, and no
 * number in it is estimated, rounded up, or borrowed from a different run. A
 * benchmarking tool that ships invented figures is worse than no benchmarking
 * tool at all.
 *
 * What it costs. One unit of `raglab:runs` — the platform allows six a day across
 * every visitor. All twelve configurations ride on one run id, which is the same
 * mechanism the browser relies on and the reason a twelve-config comparison is
 * charged once rather than twelve times.
 *
 * Flags:
 *   --cache-dir=DIR  Reuse vectors already fetched into DIR, and store new ones
 *                    there. Mirrors the browser's IndexedDB cache. A fully warm
 *                    cache makes no HTTP request and therefore costs no quota,
 *                    but it also records no fresh timings — the provenance block
 *                    then describes the cached run, and says so.
 *   --out=FILE       Fixture path. Defaults to src/example/benchmark.json.
 *   --dry-run        Score and print, write nothing.
 *
 * Environment:
 *   SUPABASE_ANON_KEY   required (unless every vector is already cached)
 *   SUPABASE_URL        defaults to the deployed project
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')

/** Already public: it is in the deployed bundle and in .github/workflows/keepalive.yml. */
export const DEFAULT_SUPABASE_URL = 'https://jayflvpyrdvqhmftiokp.supabase.co'

/**
 * The matrix the shipped example records.
 *
 * Chosen so the drill-down has something to teach, which is the part of this app
 * worth showing. A matrix where every configuration answers every question
 * produces a tidy leaderboard and explains nothing, and on this document that is
 * the easy outcome: at 320 characters and k≥2 several configurations reach MRR
 * 1.000 and the diagnostics go blank. This selection was picked after measuring
 * 96 combinations of chunker × size × model × k against the live function, on the
 * evidence rather than on taste.
 *
 *   Three chunkers, so the comparison is between strategies rather than settings.
 *
 *   80 and 160 characters. 80 is below the arithmetic floor for the four longest
 *     gold passages — they run 161–166 characters, and half of that cannot fit in
 *     an 80-character chunk — so every configuration at that size reports
 *     `impossible` on them rather than blaming the embedding model. 160 clears
 *     the floor for all fifteen, so the pair isolates exactly one variable and
 *     the chart shows the step it produces.
 *
 *   Both models, because the interesting result is that the expensive one does
 *     not win: 3-large costs 6.5× more per token and, at these sizes, loses to
 *     3-small on one chunker and ties it on another.
 *
 *   k=1. The honest reason for k=1 rather than a more conventional 3: at k≥2 the
 *     best configuration answers all fifteen and the winner's drill-down has
 *     nothing in it. k=1 keeps the top of the leaderboard at 0.933 with one real
 *     miss — a passage the embedding ranked second and the cutoff discarded,
 *     which is the `depth` verdict the drill-down exists to name.
 *
 * Twelve configurations is the app's own ceiling (`MAX_CONFIGS`), so the example
 * is also the largest comparison a visitor could run themselves.
 */
export const MATRIX = {
  chunkers: ['fixed', 'sentence-window', 'recursive'],
  sizes: [80, 160],
  overlaps: [40],
  models: ['text-embedding-3-small', 'text-embedding-3-large'],
  ks: [1],
}

/* ---------------------------------------------------------------------------
 * Loading the app's own modules
 * ------------------------------------------------------------------------ */

/**
 * Imports the application's TypeScript through Vite.
 *
 * The point of the script is to exercise the shipped code paths, not a Node
 * re-implementation of them: the scoring, the batching and the run-id reuse all
 * have to be the same functions the browser calls, or the fixture documents
 * something that never ran.
 */
export async function loadApp() {
  const load = async (rel) => (await runnerImport(path.join(APP_ROOT, rel))).module
  const [chunkers, metrics, engine, embed, persist, sample] = await Promise.all([
    load('src/lib/chunkers.ts'),
    load('src/lib/metrics.ts'),
    load('src/lib/engine.ts'),
    load('src/lib/embed.ts'),
    load('src/lib/persist.ts'),
    load('src/samples/founding-documents.ts'),
  ])
  return { chunkers, metrics, engine, embed, persist, sample }
}

/* ---------------------------------------------------------------------------
 * Talking to the deployed function
 * ------------------------------------------------------------------------ */

/**
 * Signs in anonymously, exactly as a first-time visitor's browser does.
 *
 * Anonymous is deliberate rather than convenient: it is the tier the example is
 * meant to spare, so recording it under a privileged identity would be measuring
 * a path no visitor takes.
 */
export async function anonymousToken(url, anonKey) {
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`Anonymous sign-in failed (${res.status}): ${await res.text()}`)
  const body = await res.json()
  if (!body.access_token) throw new Error('Anonymous sign-in returned no access token')
  return body.access_token
}

/**
 * A transport for `createEmbedder`, plus the counters that become provenance.
 *
 * `createEmbedder` is the browser's, untouched. It is what splits a chunking into
 * batches and threads one run id through all of them, so `stats.runIds.size === 1`
 * at the end is a measured fact about the deployed function and not an assumption.
 */
export function liveTransport({ url, anonKey, token, stats }) {
  return async function transport(body) {
    const started = Date.now()
    const res = await fetch(`${url}/functions/v1/raglab-embed`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      let message = text
      try {
        message = JSON.parse(text).error ?? text
      } catch {
        /* non-JSON body; the raw text is the best message available */
      }
      throw new Error(`raglab-embed ${res.status}: ${message}`)
    }
    const parsed = JSON.parse(text)
    stats.batches += 1
    stats.vectors += parsed.vectors.length
    stats.chars += body.texts.reduce((n, t) => n + t.length, 0)
    stats.runIds.add(parsed.runId)
    stats.dims.set(body.model, parsed.vectors[0]?.length ?? 0)
    stats.httpMs += Date.now() - started
    return parsed
  }
}

/* ---------------------------------------------------------------------------
 * Disk cache
 * ------------------------------------------------------------------------ */

const cacheName = (texts, model) => {
  const h = createHash('sha256')
  h.update(model)
  for (const t of texts) {
    h.update(' ')
    h.update(t)
  }
  return `${h.digest('hex').slice(0, 40)}.f32`
}

/**
 * Wraps an embedder in an on-disk vector store, the same bargain the browser
 * makes with IndexedDB.
 *
 * Float32 on the way in and out, because that is what the browser cache stores
 * and `quantize` collapses both paths to: a warm run and a cold run have to rank
 * a near-tie identically or the "same inputs, same numbers" claim is false.
 *
 * The cache lives outside the repository. Vectors are the one artefact this whole
 * project exists to keep out of persisted storage, and a fixture directory that
 * quietly accumulated 14 MB of floats would be the exact mistake the app argues
 * against.
 */
export function withDiskCache(embed, dir, stats) {
  return async function cached(texts, model) {
    if (texts.length === 0) return []
    const file = path.join(dir, cacheName(texts, model))
    try {
      const buf = await readFile(file)
      const count = buf.readInt32LE(0)
      const dim = buf.readInt32LE(4)
      const floats = new Float32Array(buf.buffer, buf.byteOffset + 8, count * dim)
      stats.cacheHits += 1
      stats.dims.set(model, dim)
      return Array.from({ length: count }, (_, i) =>
        Array.from(floats.subarray(i * dim, (i + 1) * dim)))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }

    const vectors = await embed(texts, model)
    const count = vectors.length
    const dim = count === 0 ? 0 : vectors[0].length
    const buf = Buffer.alloc(8 + count * dim * 4)
    buf.writeInt32LE(count, 0)
    buf.writeInt32LE(dim, 4)
    const floats = new Float32Array(buf.buffer, buf.byteOffset + 8, count * dim)
    for (let i = 0; i < count; i++) floats.set(vectors[i], i * dim)
    await mkdir(dir, { recursive: true })
    await writeFile(file, buf)
    stats.cacheMisses += 1
    return vectors
  }
}

/** A fresh counter block. Everything in the fixture's provenance comes from here. */
export const newStats = () => ({
  batches: 0,
  vectors: 0,
  chars: 0,
  httpMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
  runIds: new Set(),
  dims: new Map(),
})

/* ---------------------------------------------------------------------------
 * Running it
 * ------------------------------------------------------------------------ */

/**
 * Scores a matrix and returns the results together with what it cost.
 *
 * Nothing here re-implements scoring — `runBenchmark` is called exactly as the
 * Run button calls it, with the IndexedDB cache disabled because there is no
 * IndexedDB here and the disk cache already sits one layer up.
 */
export async function scoreMatrix(app, configs, embedder) {
  const started = Date.now()
  const results = await app.engine.runBenchmark(
    app.sample.SAMPLE_DOC.text,
    app.sample.SAMPLE_QUESTIONS,
    configs,
    (done, total) => process.stderr.write(`\r  scored ${done}/${total} configurations`),
    { embed: embedder, cache: null, fingerprint: `sample:${app.sample.SAMPLE_DOC.id}` },
  )
  process.stderr.write('\n')
  return { results, elapsedMs: Date.now() - started }
}

/* ---------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------ */

const pct = (n) => `${Math.round(n * 100)}%`

/** Counts the three verdicts the drill-down distinguishes, using its own rules. */
export function verdictCounts(app, results) {
  const counts = { hit: 0, depth: 0, boundary: 0, impossible: 0 }
  const byId = new Map(app.sample.SAMPLE_QUESTIONS.map((q) => [q.id, q]))
  for (const result of results) {
    for (const outcome of result.perQuestion) {
      const gold = byId.get(outcome.questionId).gold
      if (outcome.hit) counts.hit += 1
      else if (outcome.firstHitRank !== null) counts.depth += 1
      else if (app.engine.isUnreachable(gold, result.config)) counts.impossible += 1
      else counts.boundary += 1
    }
  }
  return counts
}

export function printLeaderboard(app, results) {
  const ranked = [...results].sort((a, b) => (b.mrr - a.mrr) || (b.hitRate - a.hitRate))
  console.log('\n  #  configuration                                              hit@k    MRR  chunks')
  ranked.forEach((r, i) => {
    const label = app.engine.configLabel(r.config).padEnd(56)
    console.log(
      `  ${String(i + 1).padStart(2)} ${label} ${pct(r.hitRate).padStart(5)}`
      + `  ${r.mrr.toFixed(3)}  ${String(r.chunkCount).padStart(5)}`,
    )
  })
  return ranked
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { cacheDir: null, out: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true
    else if (arg.startsWith('--cache-dir=')) out.cacheDir = arg.slice('--cache-dir='.length)
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const url = process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
  const outFile = args.out ?? path.join(APP_ROOT, 'src/example/benchmark.json')

  console.log('RAG Lab — recording the bundled example against the live function.')
  console.log(`  endpoint   ${url}/functions/v1/raglab-embed`)
  console.log(`  cache      ${args.cacheDir ?? 'disabled — every vector is bought fresh'}`)

  const app = await loadApp()
  const configs = app.engine.expandMatrix(MATRIX)
  console.log(`  matrix     ${configs.length} configurations, `
    + `${app.sample.SAMPLE_QUESTIONS.length} labelled questions`)

  const stats = newStats()
  let embedder = null
  const live = () => {
    if (!anonKey) {
      throw new Error(
        'SUPABASE_ANON_KEY is not set, and the vectors are not all cached. Recording the '
        + 'example means calling the deployed function; there is no offline substitute that '
        + 'would produce honest numbers.',
      )
    }
    return embedder
  }

  if (anonKey) {
    const token = await anonymousToken(url, anonKey)
    embedder = app.embed.createEmbedder(liveTransport({ url, anonKey, token, stats }))
    console.log('  session    anonymous, as a first-time visitor')
  }

  const embed = args.cacheDir
    ? withDiskCache((texts, model) => live()(texts, model), args.cacheDir, stats)
    : (texts, model) => live()(texts, model)

  const { results, elapsedMs } = await scoreMatrix(app, configs, embed)

  const ranked = printLeaderboard(app, results)
  const counts = verdictCounts(app, results)
  const winner = ranked[0]
  const winnerMissed = winner.perQuestion.filter((p) => !p.hit)

  console.log(`\n  verdicts   ${counts.hit} hit · ${counts.depth} depth · `
    + `${counts.boundary} boundary · ${counts.impossible} impossible`)
  console.log(`  winner     ${app.engine.configLabel(winner.config)} `
    + `missed ${winnerMissed.length} of ${winner.perQuestion.length}`)
  for (const miss of winnerMissed) {
    console.log(`               ${miss.questionId}: rank=${miss.firstHitRank ?? 'nowhere'} `
      + `bestOverlap=${miss.bestOverlap}`)
  }
  console.log(`\n  spend      ${stats.batches} HTTP batches, ${stats.vectors} vectors bought, `
    + `${stats.cacheHits} cache hits`)
  console.log(`  run ids    ${stats.runIds.size} `
    + `(one means the whole matrix cost a single unit of raglab:runs)`)
  for (const [model, dim] of stats.dims) console.log(`  dims       ${model} → ${dim}`)

  if (winnerMissed.length === 0) {
    console.warn(
      '\n  WARNING: the winning configuration answered every question. The example would '
      + 'show a drill-down with nothing to diagnose. Lower k or add a smaller chunk size.',
    )
  }

  const fixture = buildFixture(app, {
    results,
    configs,
    elapsedMs,
    stats,
    cached: Boolean(args.cacheDir) && stats.cacheHits > 0,
  })

  // The app's own pre-persist guard, run against the fixture for the same reason
  // the browser runs it before an insert: this is the file most likely to grow a
  // vector by accident, because it is the only one written by a machine.
  app.persist.assertNoVectors(fixture.results)

  const json = `${JSON.stringify(fixture, null, 2)}\n`
  console.log(`\n  fixture    ${(json.length / 1024).toFixed(1)} KB`)

  if (args.dryRun) {
    console.log('  --dry-run given; nothing written.')
    return fixture
  }
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, json)
  console.log(`  written    ${outFile}`)
  return fixture
}

/**
 * Assembles the fixture: metrics, the question set that produced them, and a
 * provenance block that says when this was measured and what it was measured with.
 *
 * The provenance is not decoration. A saved benchmark with no date and no model
 * list is indistinguishable from a mock-up, and the app's whole argument is that
 * the difference matters.
 */
export function buildFixture(app, { results, configs, elapsedMs, stats, cached }) {
  const doc = app.sample.SAMPLE_DOC
  return {
    schema: 1,
    provenance: {
      capturedAt: new Date().toISOString(),
      source: 'raglab-embed Edge Function, OpenAI embeddings',
      tier: 'anonymous session',
      elapsedMs,
      httpBatches: stats.batches,
      vectorsPurchased: stats.vectors,
      charactersEmbedded: stats.chars,
      runIds: stats.runIds.size,
      quotaUnits: stats.runIds.size,
      cacheAssisted: cached,
      // The coverage a retrieved chunk needs before it counts as a hit. Recorded
      // because every hit rate and MRR below is a statement about this number,
      // and a scoreboard whose scoring rule is implicit is not reproducible.
      hitThreshold: app.metrics.DEFAULT_THRESHOLD,
      models: [...new Set(configs.map((c) => c.model))].map((id) => ({
        id,
        label: app.engine.EMBEDDING_MODELS[id]?.label ?? id,
        dims: stats.dims.get(id) ?? null,
      })),
    },
    document: {
      id: doc.id,
      title: doc.title,
      source: doc.source,
      license: doc.license,
      characters: doc.text.length,
      fingerprint: `sample:${doc.id}`,
    },
    matrix: MATRIX,
    questions: app.persist.withGoldText(doc.text, app.sample.SAMPLE_QUESTIONS),
    results,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n${e.stack ?? e}`)
    process.exitCode = 1
  })
}
