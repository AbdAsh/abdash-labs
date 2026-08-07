#!/usr/bin/env node
/**
 * Captures the example reports in `src/example/` from the deployed function.
 *
 * The example path exists because a reviewer will not wait fifteen seconds and
 * spend their one daily review before finding out what a report looks like. The
 * only honest way to show them one is to show them a real one, so this script
 * is the whole provenance story: every byte under `src/example/` came out of
 * `critiq-review` running against a live URL, and this is the thing that runs
 * it. Nothing in a fixture is written by hand.
 *
 * Two capture modes, and the fixture records which one produced it:
 *
 *   live     — sign in anonymously, POST the URL, then read the stored row back.
 *              Costs one review from a throwaway anonymous account.
 *   adopted  — skip the run and read an existing report by slug. Same data, no
 *              quota; used when the review you want already happened.
 *
 * The read-back matters. The function's POST response carries the findings but
 * not the digest, and the digest is what the report page renders as "what
 * Critiq read from the page" — so a fixture built from the POST alone would be
 * missing half the UI. `report_by_slug` returns the row exactly as the report
 * route sees it, which is what makes example mode render through the same
 * components with no special cases.
 *
 * Usage:
 *   node apps/critiq/scripts/capture-example.mjs                  # re-run all, live
 *   node apps/critiq/scripts/capture-example.mjs --only js-only
 *   node apps/critiq/scripts/capture-example.mjs --only self-audit --slug qeqrbm7xsczv
 *
 * Environment (either spelling; a repo-root .env is read if present):
 *   SUPABASE_URL      / VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY
 *
 * Re-running does not reproduce a fixture byte for byte, and that is not a bug.
 * Roughly half of every report is a language model's judgment, so a second run
 * of the same URL returns different findings — and the page itself may have
 * changed since. A regenerated fixture is a new true report, not a copy of the
 * old one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const OUT_DIR = join(APP_ROOT, 'src', 'example')

/**
 * The examples, and why each one is here. Ids match the filenames in
 * `src/example/` and the keys in its `index.ts`.
 *
 * Editorial copy — titles, blurbs, the sentence explaining what to look at —
 * deliberately lives in `src/example/index.ts` rather than here. These files
 * hold captured output and nothing else, so there is no place in a fixture for
 * a human to put a claim the function did not make.
 */
const EXAMPLES = [
  {
    id: 'self-audit',
    url: 'https://abdash.net',
    note: "The author's own site. The findings are real criticism of it.",
  },
  {
    id: 'js-only',
    url: 'https://excalidraw.com',
    note: 'A client-rendered SPA, for the js-only-content critical finding.',
  },
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = { ...loadDotEnv(join(REPO_ROOT, '.env')), ...process.env }

  const supabaseUrl = firstOf(env, ['SUPABASE_URL', 'VITE_SUPABASE_URL'])
  const anonKey = firstOf(env, ['SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY'])
  if (!supabaseUrl || !anonKey) {
    throw new Error(
      'Set SUPABASE_URL and SUPABASE_ANON_KEY (or the VITE_ spellings) in the ' +
        'environment or in a repo-root .env.',
    )
  }

  const wanted = args.only ? EXAMPLES.filter((e) => e.id === args.only) : EXAMPLES
  if (wanted.length === 0) {
    throw new Error(`Unknown example "${args.only}". Known: ${EXAMPLES.map((e) => e.id).join(', ')}`)
  }
  if (args.slug && wanted.length !== 1) {
    throw new Error('--slug adopts one existing report, so it needs --only <id>.')
  }

  mkdirSync(OUT_DIR, { recursive: true })

  for (const example of wanted) {
    const api = new Critiq(supabaseUrl.replace(/\/$/, ''), anonKey)
    // A fresh anonymous account per example: the tier allows one review a day,
    // so a single session cannot capture two live examples.
    await api.signInAnonymously()

    let slug = args.slug
    let mode = 'adopted'

    if (!slug) {
      mode = 'live'
      process.stdout.write(`${example.id}: reviewing ${example.url} … `)
      const started = Date.now()
      const run = await api.review(example.url)
      slug = run.slug
      process.stdout.write(`${Math.round((Date.now() - started) / 1000)}s → ${slug}\n`)
      if (run.cached) {
        // Only reachable if this account somehow already reviewed the URL today.
        console.warn(`  note: the function served a cached report for ${example.url}`)
      }
      if (run.judgeError) {
        console.warn(`  warning: the judge failed (${run.judgeError}); this report is checks-only`)
      }
    } else {
      process.stdout.write(`${example.id}: adopting stored report ${slug} … `)
    }

    const report = await api.reportBySlug(slug)
    if (!report) throw new Error(`No report at slug ${slug} — nothing to capture.`)
    assertUsable(report, example)

    const file = join(OUT_DIR, `${example.id}.json`)
    writeFileSync(file, `${JSON.stringify(buildFixture(supabaseUrl, example, mode, report), null, 2)}\n`)

    const findings = report.findings ?? []
    const passed = Array.isArray(report.digest?.passed) ? report.digest.passed.length : 0
    console.log(
      `${mode === 'live' ? '  ' : ''}wrote ${file}\n` +
        `  ${report.url} · overall ${report.grades?.overall ?? '?'} · ` +
        `${findings.length} finding(s) · ${passed} check(s) passed · reviewed ${report.created_at}`,
    )
    for (const finding of findings) {
      console.log(`    - ${finding.severity.padEnd(8)} ${finding.source.padEnd(5)} ${finding.title}`)
    }
  }

  console.log(
    '\nFixtures are captured output. Check the grades and findings above against ' +
      'the JSON before committing — a regenerated example is a new real report, ' +
      'not a refresh of the old one.',
  )
}

/**
 * The file that lands in `src/example/`.
 *
 * `report` is the row verbatim. Everything the loader and the UI say about
 * provenance is derived from `capture` plus `report.created_at`, so the date on
 * the banner is the moment the review actually ran rather than the moment
 * someone regenerated a file.
 */
function buildFixture(supabaseUrl, example, mode, report) {
  return {
    // Not `$schema`: that key means something to editors, which then try to
    // fetch it and report a problem when this prose turns out not to be a URI.
    $generatedBy: 'apps/critiq/scripts/capture-example.mjs',
    $warning:
      'Generated file. Do not edit by hand: everything below is the response of the ' +
      'deployed critiq-review function, and hand-editing it would turn a real report ' +
      'into a fabricated one.',
    capture: {
      id: example.id,
      mode,
      why: example.note,
      requestedUrl: example.url,
      endpoint: `${supabaseUrl}/functions/v1/critiq-review`,
      slug: report.slug,
      /** When the review ran. This is what the page labels the example with. */
      reviewedAt: report.created_at,
      /** When this file was written. Later than `reviewedAt` for an adopted report. */
      capturedAt: new Date().toISOString(),
    },
    report,
  }
}

/** Refuses to write a fixture that would render as a broken report. */
function assertUsable(report, example) {
  const problems = []
  if (report.status !== 'complete') problems.push(`status is "${report.status}"`)
  if (!report.grades?.overall) problems.push('no overall grade')
  if (!report.digest) problems.push('no digest, so the measurements panel would be empty')
  if (!Array.isArray(report.findings)) problems.push('findings is not an array')
  if (problems.length > 0) {
    throw new Error(`${example.id}: refusing to write an unusable fixture — ${problems.join('; ')}.`)
  }
}

// ---------------------------------------------------------------------------

/** The two endpoints this needs, over plain fetch — the script must run with
 *  nothing installed beyond what the repo already has. */
class Critiq {
  #url
  #anonKey
  #jwt = null

  constructor(url, anonKey) {
    this.#url = url
    this.#anonKey = anonKey
  }

  async signInAnonymously() {
    const res = await fetch(`${this.#url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: this.#anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
    })
    const body = await readJson(res)
    if (!res.ok || typeof body?.access_token !== 'string') {
      throw new Error(`Anonymous sign-in failed (${res.status}): ${summarise(body)}`)
    }
    this.#jwt = body.access_token
  }

  async review(url) {
    const res = await fetch(`${this.#url}/functions/v1/critiq-review`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ url }),
    })
    const body = await readJson(res)
    if (!res.ok) throw new Error(`Review of ${url} failed (${res.status}): ${summarise(body)}`)
    return body
  }

  /** The stored row, digest and all — the same call the report route makes. */
  async reportBySlug(slug) {
    const res = await fetch(`${this.#url}/rest/v1/rpc/report_by_slug`, {
      method: 'POST',
      headers: { ...this.#headers(), 'accept-profile': 'critiq', 'content-profile': 'critiq' },
      body: JSON.stringify({ p_slug: slug }),
    })
    const body = await readJson(res)
    if (!res.ok) throw new Error(`Reading report ${slug} failed (${res.status}): ${summarise(body)}`)
    return Array.isArray(body) ? (body[0] ?? null) : (body ?? null)
  }

  #headers() {
    return {
      apikey: this.#anonKey,
      authorization: `Bearer ${this.#jwt ?? this.#anonKey}`,
      'content-type': 'application/json',
    }
  }
}

function parseArgs(argv) {
  const args = { only: null, slug: null }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i])
    const value = () => inline ?? argv[++i]
    if (flag === '--only') args.only = value()
    else if (flag === '--slug') args.slug = value()
    else if (flag === '--help' || flag === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else throw new Error(`Unknown argument "${argv[i]}".`)
  }
  return args
}

function splitFlag(token) {
  const at = token.indexOf('=')
  return at === -1 ? [token, undefined] : [token.slice(0, at), token.slice(at + 1)]
}

/** Enough .env parsing for `KEY=value`. Not a dotenv replacement, and does not
 *  need to be: this reads two variables on a developer machine. */
function loadDotEnv(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || line.trimStart().startsWith('#')) continue
    out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function firstOf(source, names) {
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function summarise(body) {
  if (typeof body === 'string') return body.slice(0, 300)
  const message = body?.error ?? body?.msg ?? body?.message
  return typeof message === 'string' ? message : JSON.stringify(body).slice(0, 300)
}

// Last, not first: `class` declarations sit in the temporal dead zone until the
// module body has run past them, so calling main() at the top would fail on
// `Critiq` before anything reached the network.
main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
