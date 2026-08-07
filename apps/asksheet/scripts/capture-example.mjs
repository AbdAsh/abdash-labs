#!/usr/bin/env node
/**
 * Captures the bundled "finished example" by planning three real questions
 * against the deployed `asksheet-plan` function.
 *
 *     SUPABASE_ANON_KEY=... node apps/asksheet/scripts/capture-example.mjs
 *
 * Why this exists. AskSheet is an awkward product to pre-record, because the
 * expensive half is invisible: the sample is already in the bundle, DuckDB runs
 * on the visitor's machine, and results are instant and free. The only thing
 * that costs a round trip and a unit of quota is *planning* the query — so that
 * is the only thing worth saving, and the browser recomputes everything else.
 *
 * The saved SQL therefore has to be real. A hand-written statement would
 * demonstrate the author's SQL rather than the product's, and would drift
 * silently the first time the prompt or the model changed. This boots a real
 * DuckDB, loads the real bundled CSV, profiles it with the app's own
 * `buildProfile`, and drives the app's own `ask()` loop against the live Edge
 * Function. What lands in `src/example/fixture.json` is exactly what came back:
 * SQL, narration, and the Vega-Lite spec when the planner chose to emit one.
 *
 * What it costs. One unit of `asksheet:plans` per question, from a fresh
 * anonymous session — the same tier and the same 20-a-day ceiling a first-time
 * visitor gets. A question whose first statement fails spends two, exactly as it
 * would in the browser, and the fixture records that it did.
 *
 * What is not captured. Results. No number the visitor sees comes from this
 * file. The `observed` block records the column names and row count seen at
 * capture time so `example.test.ts` can catch a fixture that has drifted from
 * the sample; it is never rendered.
 *
 * Flags:
 *   --out=FILE   Fixture path. Defaults to src/example/fixture.json.
 *   --dry-run    Plan, run, print, write nothing. Still spends quota — the
 *                planner is what is being exercised.
 *
 * Environment:
 *   SUPABASE_ANON_KEY   required
 *   SUPABASE_URL        defaults to the deployed project
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')

/** Already public: it is in the deployed bundle and in the sibling recorders. */
const DEFAULT_SUPABASE_URL = 'https://jayflvpyrdvqhmftiokp.supabase.co'

/** The fixture format. Bump when `src/example/index.ts` stops being able to read
 *  an older file, so a stale fixture fails loudly rather than half-rendering. */
const SCHEMA = 1

/** The sample the example path is built on. Its outlier is the app's stated
 *  success criterion, pinned in `src/samples/samples.test.ts`. */
const SAMPLE_ID = 'saas-revenue'
const TABLE = 'data'

/**
 * Three questions, chosen for range rather than for flattering the model.
 *
 *   0 — the headline the README promises, worded exactly as it is written there.
 *       A ranking: one row, one number, no picture.
 *   1 — a follow-up, and the other half of the headline. "That month" resolves
 *       only from question 0's SQL, so this demonstrates the thing that is
 *       easiest to miss about the design — what carries conversation context is
 *       prior *SQL*, never prior results — while the breakdown it returns is
 *       what actually explains the spike.
 *   2 — a different shape entirely: a trend across a dimension, twenty-four
 *       points times three regions, and the one that asks for a picture. The
 *       planner only returns a Vega-Lite spec when the question wants one, so
 *       three rankings would have shown the chart path not at all.
 */
const QUESTIONS = [
  { text: 'Which month had the highest revenue and why is it an outlier?', follows: null },
  { text: 'Now break that month down by plan and contract type', follows: 0 },
  { text: 'Chart monthly revenue by region so I can see where the growth is', follows: null },
]

/** Mirrors the Edge Function's guard, so an oversized request fails here and
 *  loudly rather than as a 413 from the other side. */
const MAX_REQUEST_BYTES = 32 * 1024

const args = process.argv.slice(2)
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const DRY_RUN = args.includes('--dry-run')
const OUT = path.resolve(APP_ROOT, flag('out') ?? 'src/example/fixture.json')

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function say(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * Loads the app's own TypeScript, so the profiling and the ask loop exercised
 * here are the ones the browser ships — `?raw` CSV import included.
 *
 * One server, not `runnerImport` per module as the sibling recorder in
 * `apps/raglab` uses. That matters here and not there: this script injects a
 * planner into `runtime.ts` and then calls `ask()` from `plan.ts`, and
 * `runnerImport` gives each call its own module graph — so the registry `ask()`
 * reads from would be a different instance of `runtime.ts` from the one that was
 * written to, and the injection would silently do nothing. A single dev server
 * evaluates every module in one graph, which is the whole point.
 */
async function loadApp() {
  const server = await createServer({
    root: APP_ROOT,
    configFile: false,
    logLevel: 'warn',
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  const load = (rel) => server.ssrLoadModule(`/${rel}`)
  const [nodeDuck, duck, runtime, plan, validate, samples] = await Promise.all([
    load('test/nodeDuck.ts'),
    load('src/lib/duck.ts'),
    load('src/lib/runtime.ts'),
    load('src/lib/plan.ts'),
    load('src/lib/validate.ts'),
    load('src/samples/index.ts'),
  ])
  return { server, nodeDuck, duck, runtime, plan, validate, samples }
}

/**
 * An anonymous session, because `asksheet-plan` verifies a real user JWT and
 * meters against it. Same tier a first-time visitor gets, so the capture is
 * subject to the same ceiling they are.
 */
async function signInAnonymously(url, anonKey) {
  const response = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || typeof body?.access_token !== 'string') {
    throw new Error(`Anonymous sign-in failed (${response.status}): ${JSON.stringify(body)}`)
  }
  return body.access_token
}

/**
 * The planner, over plain fetch.
 *
 * `src/lib/planClient.ts` is not reusable here: it goes through the shared
 * supabase-js client, which reads `import.meta.env` at import time and persists
 * a session to browser storage. What has to be faithful is the wire format, and
 * that is reproduced exactly — same URL, same body, same size guard. Every
 * request is recorded, so the fixture can show the bytes that produced each
 * statement rather than merely asserting they were small.
 */
function makePlanner(endpoint, anonKey, jwt, log) {
  return async (request) => {
    const size = bytes(request)
    if (size > MAX_REQUEST_BYTES) {
      throw new Error(`Request is ${size} bytes, over the ${MAX_REQUEST_BYTES}-byte limit.`)
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`asksheet-plan returned ${response.status}: ${body?.error ?? '(no body)'}`)
    }
    if (typeof body?.sql !== 'string' || body.sql === '') {
      throw new Error(`asksheet-plan returned no SQL: ${JSON.stringify(body)}`)
    }

    log.push({ request, requestBytes: size, response: body })
    return {
      sql: body.sql,
      narration: typeof body.narration === 'string' ? body.narration : '',
      ...(body.chart && typeof body.chart === 'object' ? { chart: body.chart } : {}),
    }
  }
}

/**
 * The app's own privacy boundary, re-applied to the file about to be written.
 *
 * `example.test.ts` checks all of this too, but a bad capture should never reach
 * disk in the first place: the fixture is a verbatim copy of bodies that crossed
 * the network, and it ships in the bundle where anyone can read it. Refusing to
 * write is cheaper than noticing later.
 */
function assertSafeToShip(fixture, csv, assertSingleSelect) {
  const sourceRows = csv.trim().split('\n').slice(1).map((line) => line.split(','))

  for (const plan of fixture.plans) {
    const keys = Object.keys(plan.request).sort()
    const allowed = plan.request.repair
      ? ['history', 'profile', 'question', 'repair']
      : ['history', 'profile', 'question']
    if (keys.join() !== allowed.join()) {
      throw new Error(`Captured request has unexpected keys: ${keys.join(', ')}`)
    }

    const profileKeys = Object.keys(plan.request.profile).sort().join()
    if (profileKeys !== 'columns,rowCount,table') {
      throw new Error(`Captured profile has unexpected keys: ${profileKeys}`)
    }

    // The property the README claims of live traffic, checked against bytes that
    // really crossed: not "how many values were sent" but "how many rows can be
    // rebuilt from them".
    const sampleSets = plan.request.profile.columns.map((column) => new Set(column.samples))
    const rebuilt = sourceRows.filter((row) =>
      row.every((value, index) => sampleSets[index]?.has(value)),
    )
    if (rebuilt.length > 0) {
      throw new Error(`${rebuilt.length} source row(s) are reconstructible from a captured profile.`)
    }

    // Saved model output is still model output.
    assertSingleSelect(plan.sql)
  }
}

async function main() {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!anonKey) {
    throw new Error('Set SUPABASE_ANON_KEY. This captures against the deployed function.')
  }
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? DEFAULT_SUPABASE_URL)
    .replace(/\/+$/, '')
  const endpoint = `${url}/functions/v1/asksheet-plan`

  const app = await loadApp()
  try {
    await capture(app, url, endpoint, anonKey)
  } finally {
    await app.server.close()
  }
}

async function capture(app, url, endpoint, anonKey) {
  const sample = app.samples.findSample(SAMPLE_ID)
  if (!sample) throw new Error(`No bundled sample called ${SAMPLE_ID}.`)

  say(`Booting DuckDB and loading ${sample.name} (${sample.rows} rows)…`)
  app.duck.attachDuck(await app.nodeDuck.bootNodeDuck())
  await app.duck.registerCsv(sample.csv, TABLE)

  const jwt = await signInAnonymously(url, anonKey)
  const log = []
  app.runtime.setQueryRunner(app.duck.runQuery)
  app.runtime.setPlanner(makePlanner(endpoint, anonKey, jwt, log))

  const plans = []
  const answers = []

  for (const [index, question] of QUESTIONS.entries()) {
    // A follow-up is handed exactly what the browser would hand it: the earlier
    // question and the SQL it produced. Never the rows that SQL returned.
    const history =
      question.follows === null
        ? []
        : [{ question: QUESTIONS[question.follows].text, sql: answers[question.follows].sql }]

    say(`\nAsking: ${question.text}`)
    const before = log.length
    const answer = await app.plan.ask(question.text, TABLE, false, { history })
    answers[index] = answer

    // The last request of the turn is the one that produced the SQL kept below —
    // on a repair that is the second one, which is the honest thing to record.
    const sent = log[log.length - 1]
    say(
      `  ${log.length - before} request(s), ${sent.requestBytes} bytes` +
        `${answer.repaired ? ' (repaired)' : ''}, ` +
        `${answer.result.rows.length} row(s)${answer.chart ? ', chart' : ', no chart'}`,
    )
    say(`  ${answer.sql}`)

    plans.push({
      question: question.text,
      follows: question.follows,
      request: sent.request,
      requestBytes: sent.requestBytes,
      sql: answer.sql,
      narration: answer.narration,
      chart: answer.chart ?? null,
      repaired: answer.repaired,
      observed: {
        columns: answer.result.columns.map((column) => column.name),
        rowCount: answer.result.rows.length,
      },
    })
  }

  const fixture = {
    README:
      'GENERATED FILE — do not edit. Every sql, narration and chart below is verbatim output '
      + 'from the deployed asksheet-plan function. Regenerate with '
      + 'SUPABASE_ANON_KEY=... node apps/asksheet/scripts/capture-example.mjs',
    schema: SCHEMA,
    generatedBy: 'apps/asksheet/scripts/capture-example.mjs',
    capturedAt: new Date().toISOString(),
    endpoint,
    sampleId: SAMPLE_ID,
    table: TABLE,
    strict: false,
    plans,
  }

  assertSafeToShip(fixture, sample.csv, app.validate.assertSingleSelect)
  await app.duck.resetDuck()

  if (DRY_RUN) {
    say('\n--dry-run: nothing written.')
    return
  }

  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`)
  say(`\nWrote ${path.relative(process.cwd(), OUT)} — ${plans.length} plans.`)
}

main().catch((error) => {
  process.stderr.write(`\ncapture-example failed: ${error?.stack ?? error?.message ?? error}\n`)
  process.exitCode = 1
})
