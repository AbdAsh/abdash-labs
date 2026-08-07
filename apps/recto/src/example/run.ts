import type { Citation } from '../lib/chat'
import type { DocumentRow } from '../lib/documents'
import type { TurnData } from '../components/Turn'
import raw from './example-run.json'

/**
 * The saved example run: one real notebook, two real documents and three real
 * answers, recorded off the deployed Edge Functions by
 * `scripts/generate-example.mjs` and committed as `example-run.json`.
 *
 * The fixture is data, not code, and it is rewritten wholesale by a script — so
 * it is parsed here rather than trusted. A regeneration that half-succeeded, or
 * a hand edit that broke a field, has to fail at import with a sentence naming
 * the field, not paint a blank spread in front of a visitor.
 */

export interface ExampleDocument extends DocumentRow {
  /** SHA-256 of the generated PDF. The same bytes always hash the same way, so
   *  this is what makes the run reproducible rather than merely repeatable. */
  contentHash: string
  chunkCount: number
}

export interface ExampleTurn extends TurnData {
  /** What the HTTP call actually cost and returned, kept so the recording can
   *  be read as a record of a request rather than as decoration. */
  elapsedMs: number
}

export interface ExampleRun {
  /** ISO 8601, from the machine that ran the capture. */
  capturedAt: string
  models: { embedding: string; answer: string }
  /** The free tier the capture ran under — the same one a first-time visitor
   *  gets, which is why the tallies in the sources panel read as they do. */
  tier: { notebooks: number; documents: number; messages: number }
  fiction: { company: string; statement: string }
  notebook: { id: string; title: string; createdAt: string }
  documents: ExampleDocument[]
  conversation: { id: string; title: string }
  turns: ExampleTurn[]
}

class FixtureError extends Error {
  constructor(where: string, what: string) {
    super(`example-run.json is not usable: ${where} ${what}. Regenerate it with \`npm run example -w apps/recto\`.`)
    this.name = 'FixtureError'
  }
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FixtureError(where, 'is not an object')
  }
  return value as Record<string, unknown>
}

function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new FixtureError(where, 'is not a string')
  return value
}

function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FixtureError(where, 'is not a number')
  }
  return value
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new FixtureError(where, 'is not a boolean')
  return value
}

function arr(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FixtureError(where, 'is not a non-empty array')
  }
  return value
}

function citation(value: unknown, where: string): Citation {
  const c = obj(value, where)
  return {
    n: num(c.n, `${where}.n`),
    // Null is legitimate: `chunks.page` is nullable, and a citation with no page
    // renders as an em dash rather than as page zero.
    page: c.page === null ? null : num(c.page, `${where}.page`),
    document: str(c.document, `${where}.document`),
    content: str(c.content, `${where}.content`),
    similarity: num(c.similarity, `${where}.similarity`),
  }
}

/**
 * Narrows the committed JSON to the shape the interface renders.
 *
 * Two checks go beyond types, because both are ways the fixture can be
 * well-formed and still worthless:
 *
 *   - a citation numbered outside `1..citations.length` would render as dead
 *     plain text where the answer says `[n]`, so the footnote a reviewer clicks
 *     would do nothing;
 *   - fewer than two documents means the notebook cannot demonstrate the one
 *     thing it exists to demonstrate.
 */
export function parseExampleRun(value: unknown): ExampleRun {
  const root = obj(value, 'the fixture')
  const provenance = obj(root.provenance, 'provenance')
  const models = obj(root.models, 'models')
  const tier = obj(provenance.tier, 'provenance.tier')
  const fiction = obj(root.fiction, 'fiction')
  const notebook = obj(root.notebook, 'notebook')
  const conversation = obj(root.conversation, 'conversation')

  const capturedAt = str(provenance.capturedAt, 'provenance.capturedAt')
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new FixtureError('provenance.capturedAt', 'is not a date')
  }

  const documents = arr(root.documents, 'documents').map((value, i): ExampleDocument => {
    const d = obj(value, `documents[${i}]`)
    const status = str(d.status, `documents[${i}].status`)
    if (status !== 'ready') {
      throw new FixtureError(`documents[${i}].status`, `is "${status}", so it was never searchable`)
    }
    return {
      id: str(d.id, `documents[${i}].id`),
      name: str(d.name, `documents[${i}].name`),
      pageCount: d.pageCount === null ? null : num(d.pageCount, `documents[${i}].pageCount`),
      isRtl: bool(d.isRtl, `documents[${i}].isRtl`),
      status: 'ready',
      createdAt: str(d.createdAt, `documents[${i}].createdAt`),
      contentHash: str(d.contentHash, `documents[${i}].contentHash`),
      chunkCount: num(d.chunkCount, `documents[${i}].chunkCount`),
    }
  })

  if (documents.length < 2) {
    throw new FixtureError('documents', 'holds fewer than two documents, so nothing in it can be cross-document')
  }

  const turns = arr(root.turns, 'turns').map((value, i): ExampleTurn => {
    const t = obj(value, `turns[${i}]`)
    const citations = arr(t.citations, `turns[${i}].citations`).map((c, j) =>
      citation(c, `turns[${i}].citations[${j}]`),
    )
    for (const [j, c] of citations.entries()) {
      if (c.n !== j + 1) {
        throw new FixtureError(`turns[${i}].citations[${j}].n`, `is ${c.n}, not ${j + 1}`)
      }
    }
    const answer = str(t.answer, `turns[${i}].answer`)
    for (const marker of answer.matchAll(/\[(\d+)\]/g)) {
      const n = Number(marker[1])
      if (n < 1 || n > citations.length) {
        throw new FixtureError(
          `turns[${i}].answer`,
          `cites [${n}] but only ${citations.length} passages were retrieved`,
        )
      }
    }
    return {
      question: str(t.question, `turns[${i}].question`),
      answer,
      citations,
      elapsedMs: num(obj(t.http, `turns[${i}].http`).elapsedMs, `turns[${i}].http.elapsedMs`),
    }
  })

  return {
    capturedAt,
    models: {
      embedding: str(models.embedding, 'models.embedding'),
      answer: str(models.answer, 'models.answer'),
    },
    tier: {
      notebooks: num(tier.notebooks, 'provenance.tier.notebooks'),
      documents: num(tier.documents, 'provenance.tier.documents'),
      messages: num(tier.messages, 'provenance.tier.messages'),
    },
    fiction: {
      company: str(fiction.company, 'fiction.company'),
      statement: str(fiction.statement, 'fiction.statement'),
    },
    notebook: {
      id: str(notebook.id, 'notebook.id'),
      title: str(notebook.title, 'notebook.title'),
      createdAt: str(notebook.createdAt, 'notebook.createdAt'),
    },
    documents,
    conversation: {
      id: str(conversation.id, 'conversation.id'),
      title: str(conversation.title, 'conversation.title'),
    },
    turns,
  }
}

export const exampleRun: ExampleRun = parseExampleRun(raw)

/** The day the run was captured, for the label the visitor reads. Written out
 *  in full — "07/08/2026" means two different days depending on who is reading. */
export function capturedOn(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale ?? 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
