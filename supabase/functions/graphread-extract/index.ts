/**
 * graphread-extract — one coarse chunk in, entities and relations out.
 *
 * The contract this function is judged on: every relation it returns carries a
 * `quote` that the client can find verbatim in the chunk it sent. The client
 * checks and drops the ones that fail, so a model that invents a citation
 * loses the claim rather than smuggling it into the graph.
 *
 * The gate itself lives client-side and only there. Running it here too would
 * mean two implementations of the single most important rule in the project,
 * in two different runtimes, drifting apart.
 */

import { preflight, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { getCaller } from '../_shared/auth.ts'
import { consumeQuota } from '../_shared/quota.ts'
import { chatJSON, type Message } from '../_shared/openrouter.ts'

const ENTITY_TYPES = [
  'person',
  'organization',
  'place',
  'concept',
  'event',
  'artifact',
  'date',
] as const

/** Coarse chunks are ~2500 chars; the ceiling is slack, not a target. */
const MAX_CHUNK_CHARS = 6000

interface ExtractRequest {
  chunkId?: unknown
  chunkIndex?: unknown
  text?: unknown
}

interface Extraction {
  entities: { name: string; type: string; description: string }[]
  relations: { source: string; relation: string; target: string; quote: string }[]
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entities', 'relations'],
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'description'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ENTITY_TYPES },
          description: { type: 'string' },
        },
      },
    },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'relation', 'target', 'quote'],
        properties: {
          source: { type: 'string' },
          relation: { type: 'string' },
          target: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
  },
}

const SYSTEM = `You extract a knowledge graph from one passage of a document.

ENTITY TYPES — use exactly one of these seven, never invent another:
person, organization, place, concept, event, artifact, date

Rules for entities:
- Use the fullest name the passage gives ("Dr. Sarah Chen", not "Chen"), exactly as written.
- description: one short clause drawn from this passage. Never guess outside it.
- Do not emit pronouns, job titles alone, or generic nouns as entities.

Rules for relations:
- relation is a lowercase verb phrase in the passage's own terms: "founded",
  "works for", "based in", "merged with". Do not map onto a fixed vocabulary.
- source and target must each match an entity name you emitted, character for character.
- quote MUST be copied from the passage character for character. Copy a contiguous
  span of at least four words that on its own states the relation. Do not
  paraphrase it, do not correct its spelling, do not join two separate sentences,
  do not add or remove a single word.
- The quote MUST contain the name of at least one of the two entities, written
  out. A span like "the two companies competed for the same grants" is true of
  the passage and useless as evidence, because nothing in it says which two.
  Widen the span until it names one of them, or omit the relation.

Two checks run against the passage: the quote must be found by exact string
match, and it must name one of the entities it is offered as evidence for. A
relation failing either is discarded, so a relation you cannot quote is worth
nothing — omit it instead. Fewer, well-quoted relations beat more, loose ones.

Return only entities and relations that the passage itself asserts.`

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const caller = await getCaller(req)
    const body = (await req.json()) as ExtractRequest

    const chunkId = typeof body.chunkId === 'string' ? body.chunkId : ''
    const text = typeof body.text === 'string' ? body.text : ''
    const chunkIndex = typeof body.chunkIndex === 'number' ? body.chunkIndex : -1

    if (!chunkId) return jsonResponse({ error: 'chunkId is required' }, 400)
    if (!text.trim()) return jsonResponse({ error: 'text is required' }, 400)
    if (text.length > MAX_CHUNK_CHARS) {
      return jsonResponse({ error: `text exceeds ${MAX_CHUNK_CHARS} characters` }, 413)
    }

    // Two meters, because one is not enough. `extractions` is the per-document
    // allowance and is charged once, on the first chunk. `chunks` is charged on
    // every call, which is what actually bounds spend: a client that lies about
    // chunkIndex to dodge the document charge still runs into the chunk ceiling.
    await consumeQuota(caller.jwt, 'graphread', 'chunks', 1)
    if (chunkIndex === 0) await consumeQuota(caller.jwt, 'graphread', 'extractions', 1)

    const messages: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `PASSAGE:\n"""\n${text}\n"""` },
    ]

    const out = await chatJSON<Extraction>(messages, SCHEMA, Deno.env.get('MODEL_CHEAP'))

    return jsonResponse({
      chunkId,
      entities: Array.isArray(out?.entities) ? out.entities : [],
      relations: Array.isArray(out?.relations) ? out.relations : [],
    })
  } catch (e) {
    return errorResponse(e)
  }
})
