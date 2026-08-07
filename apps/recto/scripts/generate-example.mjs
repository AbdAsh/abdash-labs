#!/usr/bin/env node
/**
 * Regenerates `src/example/example-run.json` by driving the *deployed* Recto
 * against two invented quarterly reports and recording exactly what comes back.
 *
 *   npm run example -w apps/recto
 *
 * needing, in the environment:
 *
 *   SUPABASE_URL       https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY  the anon key (VITE_ prefixed names are also accepted)
 *
 * WHY THIS SCRIPT EXISTS AT ALL. The example the site shows by default is a
 * recording, and a recording is only worth anything if it is a recording of
 * something. Everything in the fixture — the chunk text, the page numbers, the
 * similarity scores, the wording of every answer — arrives here over HTTP from
 * `recto-ingest` and `recto-chat` running in production. Nothing is written by
 * hand. If the fixture is ever edited directly it stops being evidence, and the
 * checkable claims the READMEs make stop being checkable.
 *
 * The run is deliberately indistinguishable from a visitor's:
 *
 *   - a fresh anonymous account, on the same free tier a first-time visitor gets
 *   - a real PDF per document, extracted by pdf.js and chunked by `chunkPages`
 *   - the same request bodies `src/lib/ingest.ts` and `src/lib/chat.ts` send
 *   - the same `\f` stream protocol, parsed the same way
 *
 * It costs, per run: one anonymous user, ten embeddings, three chat messages of
 * the day's twenty. The notebook is deleted afterwards unless `--keep` is given,
 * because the fixture is the artefact and the rows are litter. A run that throws
 * part way leaves its rows behind — deliberately, so the failure can be looked
 * at; every run takes a fresh account, so nothing collides with the next one.
 *
 * Flags:
 *   --dry-run  Build the PDFs, extract and chunk them, print the breakdown, and
 *              stop before the first network call. Costs nothing.
 *   --keep     Leave the notebook, documents and conversation in the database.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chunkPages } from '../../../packages/doc-core/src/chunk.ts'
import { isRTL } from '../../../packages/doc-core/src/rtl.ts'
import { buildPdf, extractPdf } from './pdf.mjs'
import { SOURCE_DOCUMENTS, QUESTIONS, NOTEBOOK_TITLE } from './source-documents.mjs'

/** Mirrors `src/lib/ingest.ts`. Kept identical so the fixture records the same
 *  batching a browser upload would produce. */
const BATCH = 50
const DIRECTION_SAMPLE = 4000

/** Written by the deployed functions, not chosen here — recorded so the fixture
 *  says which model produced the answers it is showing. See `models` below for
 *  how much of this is observed and how much is configuration. */
const EMBEDDING_MODEL = 'text-embedding-3-small'
const ANSWER_MODEL = 'openai/gpt-4o-mini'

const FIXTURE = new URL('../src/example/example-run.json', import.meta.url)
const PDF_DIR = new URL('../public/example/', import.meta.url)

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const KEEP = args.has('--keep')

function env(...names) {
  for (const n of names) {
    const v = process.env[n]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

const SUPABASE_URL = (env('SUPABASE_URL', 'VITE_SUPABASE_URL') ?? '').replace(/\/+$/, '')
const ANON_KEY = env('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY') ?? ''

// ─── plumbing ──────────────────────────────────────────────────────────────

function die(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

const log = (...a) => console.log(...a)

/** Every PostgREST call in this script goes through here. Both profile headers
 *  are sent on every request — PostgREST reads `Accept-Profile` on reads and
 *  `Content-Profile` on writes, and sending both saves branching on the verb. */
function restHeaders(session, schema) {
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Profile': schema,
    'Content-Profile': schema,
  }
}

async function rest(session, schema, path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders(session, schema), ...init.headers },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`PostgREST ${res.status} on ${path}: ${text}`)
  return text ? JSON.parse(text) : null
}

// ─── the run ───────────────────────────────────────────────────────────────

/** Builds each source document into a real PDF and reads it back exactly as the
 *  browser would, so the pages and chunks in the fixture are the pages and
 *  chunks an upload of the same file produces. */
async function prepare() {
  const prepared = []
  for (const source of SOURCE_DOCUMENTS) {
    const bytes = buildPdf(source.pages)
    const pages = await extractPdf(bytes)
    const chunks = chunkPages(pages)
    if (chunks.length === 0) throw new Error(`${source.name} produced no chunks`)

    prepared.push({
      name: source.name,
      bytes,
      pages,
      chunks,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      isRtl: isRTL(
        pages
          .map((p) => p.text)
          .join(' ')
          .slice(0, DIRECTION_SAMPLE),
      ),
    })
  }
  return prepared
}

async function signInAnonymously() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) {
    throw new Error(`Anonymous sign-in failed (${res.status}): ${JSON.stringify(body)}`)
  }
  return body
}

/** The same body `src/lib/ingest.ts` posts, batch for batch. */
async function ingest(session, notebookId, doc) {
  let documentId
  const responses = []

  for (let i = 0; i < doc.chunks.length; i += BATCH) {
    const final = i + BATCH >= doc.chunks.length
    const res = await fetch(`${SUPABASE_URL}/functions/v1/recto-ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notebookId,
        documentId,
        name: doc.name,
        contentHash: doc.contentHash,
        isRtl: doc.isRtl,
        pageCount: doc.pages.length,
        chunks: doc.chunks.slice(i, i + BATCH),
        final,
      }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`recto-ingest ${res.status} for ${doc.name}: ${text}`)
    const body = JSON.parse(text)
    documentId = body.documentId
    responses.push(body)
  }

  return { documentId, responses }
}

/**
 * One question, one answer, captured verbatim.
 *
 * `recto-chat` answers with a citations array, one form feed, then the answer
 * text — the protocol `src/lib/chat.ts` reads. Splitting the body at that form
 * feed is the whole of the parsing, so what is stored is byte-for-byte what the
 * function sent, only cut in two.
 */
async function ask(session, notebookId, conversationId, question) {
  const startedAt = Date.now()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/recto-chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question, notebookId, conversationId }),
  })
  const body = await res.text()
  const elapsedMs = Date.now() - startedAt

  if (!res.ok) throw new Error(`recto-chat ${res.status}: ${body}`)

  const ff = body.indexOf('\f')
  if (ff === -1) throw new Error(`recto-chat sent no form feed; body was: ${body.slice(0, 400)}`)

  return {
    question,
    answer: body.slice(ff + 1),
    citations: JSON.parse(body.slice(0, ff)),
    http: {
      status: res.status,
      conversationId: res.headers.get('x-conversation-id'),
      bodyBytes: Buffer.byteLength(body),
      elapsedMs,
    },
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

const prepared = await prepare()

log('\nSource documents')
for (const doc of prepared) {
  log(`  ${doc.name}`)
  log(
    `    ${doc.bytes.length} bytes · ${doc.pages.length} pages · ${doc.chunks.length} chunks · ` +
      `rtl=${doc.isRtl}`,
  )
  log(`    sha256 ${doc.contentHash}`)
  for (const c of doc.chunks) {
    log(`      [${String(c.index).padStart(2)}] p.${c.page}  ${c.content.length} chars`)
  }
}

const pdfDir = fileURLToPath(PDF_DIR)
mkdirSync(pdfDir, { recursive: true })
for (const doc of prepared) writeFileSync(join(pdfDir, doc.name), doc.bytes)
log(`\nWrote ${prepared.length} PDFs to apps/recto/public/example/`)

if (DRY_RUN) {
  log('\n--dry-run: stopping before the first network call. Nothing was spent.\n')
  process.exit(0)
}

if (!SUPABASE_URL || !ANON_KEY) {
  die(
    'Set SUPABASE_URL and SUPABASE_ANON_KEY (or the VITE_ prefixed names) to the\n' +
      'project the deployed functions live in, then run again:\n\n' +
      '  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<key> \\\n' +
      '    npm run example -w apps/recto\n\n' +
      'Or use --dry-run to build and chunk the documents without calling anything.',
  )
}

log('\nSigning in anonymously…')
const session = await signInAnonymously()
log(`  user ${session.user.id} (anonymous: ${session.user.is_anonymous})`)

const tier = {}
for (const key of ['notebooks', 'documents', 'messages']) {
  tier[key] = await rest(session, 'platform', 'rpc/quota_for', {
    method: 'POST',
    body: JSON.stringify({ p_app: 'recto', p_key: key }),
  })
}
log(`  tier: ${tier.notebooks} notebooks · ${tier.documents} documents · ${tier.messages} messages`)

log('\nCreating the notebook…')
const [notebookRow] = await rest(session, 'recto', 'notebooks?select=id,title,created_at', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({ title: NOTEBOOK_TITLE }),
})
log(`  ${notebookRow.id}  ${notebookRow.title}`)

const ingested = []
for (const doc of prepared) {
  log(`\nIngesting ${doc.name}…`)
  const { documentId, responses } = await ingest(session, notebookRow.id, doc)
  log(`  document ${documentId}: ${JSON.stringify(responses)}`)
  ingested.push({ doc, documentId, responses })
}

// Read the rows back rather than trusting the function's reply: `status` is what
// `match_chunks` filters on, so a document that never reached 'ready' would
// answer nothing and the fixture would record an empty notebook.
const documentRows = await rest(
  session,
  'recto',
  `documents?notebook_id=eq.${notebookRow.id}` +
    '&select=id,name,page_count,is_rtl,status,created_at&order=created_at.asc',
)
const unfinished = documentRows.filter((d) => d.status !== 'ready')
if (unfinished.length > 0) {
  const names = unfinished.map((d) => d.name).join(', ')
  throw new Error(`These documents never reached 'ready': ${names}`)
}
log(`\nAll ${documentRows.length} documents are ready.`)

const turns = []
let conversationId
for (const question of QUESTIONS) {
  log(`\nAsking: ${question}`)
  const turn = await ask(session, notebookRow.id, conversationId, question)
  conversationId = turn.http.conversationId ?? conversationId
  const cited = [...new Set(turn.citations.map((c) => c.document))]
  log(`  ${turn.http.elapsedMs} ms · ${turn.citations.length} passages retrieved`)
  log(`  documents in the citation list: ${cited.join(' | ')}`)
  log(`  answer: ${turn.answer.slice(0, 160)}${turn.answer.length > 160 ? '…' : ''}`)
  turns.push(turn)
}

const [conversationRow] = await rest(
  session,
  'recto',
  `conversations?id=eq.${conversationId}&select=id,title`,
)

const fixture = {
  kind: 'recto-example-run',
  version: 1,

  provenance: {
    capturedAt: new Date().toISOString(),
    generator: 'apps/recto/scripts/generate-example.mjs',
    supabaseUrl: SUPABASE_URL,
    functions: ['recto-ingest', 'recto-chat'],
    tier: { anonymous: true, ...tier },
    note:
      'Every field below came back over HTTP from the deployed recto-ingest and ' +
      'recto-chat on the date above. Nothing in this file was written by hand. ' +
      'Regenerate it with: npm run example -w apps/recto',
  },

  models: {
    embedding: EMBEDDING_MODEL,
    embeddingSource:
      "recto-ingest calls _shared/openai.ts `embed()` with no model argument, so it " +
      'uses DEFAULT_EMBED_MODEL — 1536 dimensions, matching the halfvec(1536) column.',
    answer: ANSWER_MODEL,
    answerSource:
      'recto-chat resolves its model from the MODEL_CHEAP Edge Function secret and the ' +
      'stream does not echo the model name back, so this records the deployed value ' +
      'documented in docs/DEPLOY.md rather than a value observed in the response.',
  },

  fiction: {
    company: 'Halverd Instruments, Inc.',
    statement:
      'Halverd Instruments does not exist. Both reports were written for this ' +
      'demonstration and imitate no real company, filing, product or person.',
    sources: 'apps/recto/scripts/source-documents.mjs',
  },

  notebook: {
    id: notebookRow.id,
    title: notebookRow.title,
    createdAt: notebookRow.created_at,
  },

  documents: documentRows.map((row) => {
    const match = ingested.find((i) => i.documentId === row.id)
    return {
      id: row.id,
      name: row.name,
      pageCount: row.page_count,
      isRtl: row.is_rtl,
      status: row.status,
      createdAt: row.created_at,
      contentHash: match.doc.contentHash,
      chunkCount: match.doc.chunks.length,
      pdfBytes: match.doc.bytes.length,
      ingestResponses: match.responses,
    }
  }),

  conversation: {
    id: conversationRow.id,
    title: conversationRow.title,
  },

  turns: turns.map((t) => ({
    question: t.question,
    answer: t.answer,
    citations: t.citations,
    http: t.http,
  })),
}

const fixturePath = fileURLToPath(FIXTURE)
mkdirSync(fileURLToPath(new URL('.', FIXTURE)), { recursive: true })
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n')
log(`\nWrote ${fixturePath}`)

if (KEEP) {
  log('\n--keep: the notebook was left in the database.')
} else {
  await rest(session, 'recto', `notebooks?id=eq.${notebookRow.id}`, { method: 'DELETE' })
  log('\nDeleted the notebook (cascades to documents, chunks and the conversation).')
}

log('\nSummary')
for (const [i, t] of turns.entries()) {
  const cited = [...new Set(t.citations.map((c) => c.document))]
  log(`  Q${i + 1} cited ${cited.length} document${cited.length === 1 ? '' : 's'}: ${cited.join(' | ')}`)
}
log('')
