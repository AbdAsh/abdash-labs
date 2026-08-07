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
- An entity is something you could look up: a person, an organisation, a place,
  a titled work or product, a date. A phrase that only means anything inside
  this passage — "field programme", "regulators", "clinics", "the same problem"
  — describes a thing rather than naming one, and is not an entity.
- A company and the product it sells are two entities even when they share a
  name: one is an organization, the other an artifact.
- Every name you use as a source or a target must also appear in this list. When
  a relation needs a year or a city the passage names, add it here rather than
  dropping the relation.

Rules for relations:
- relation is a lowercase verb phrase in the passage's own terms: "founded",
  "works for", "based in", "merged with". Do not map onto a fixed vocabulary.
- source acts and target is acted on. For "X acquired Y" the source is X. The
  passive voice does not flip that: "Y was founded by X" is still source X,
  target Y, however the sentence orders the two.
- source and target must each match an entity name you emitted, character for character.
- quote is a run of the passage lifted out between two end points — not a
  sentence you rewrite from memory. Same words, same spelling, same
  capitalisation, same punctuation as the characters actually sitting between
  those two points. A run that starts where a sentence starts keeps its capital
  letter.
- Begin and end the run on a word, and write no trailing punctuation at all —
  no full stop, no comma, no semicolon. Whatever follows your last word in the
  passage is ignored by the check, so a trailing mark can only cost you: invent
  a "." to round off a clause the passage continues with a comma and the whole
  relation dies. This is the single commonest way a good quote fails. Never
  elide with "..." and never join two sentences.
- Reach for the whole sentence that states the relation. A shorter run inside
  that sentence is fine when it still spells out the name of the source or the
  target. Four words is a hard floor, not a goal: "in Leeds" and "was founded in
  1998" are too thin to be evidence of anything.
- The quote MUST contain the name of at least one of the two entities, written
  out. A span like "the two companies competed for the same grants" is true of
  the passage and useless as evidence, because nothing in it says which two.
  Widen the span until it names one of them; omit the relation only if the whole
  sentence still names neither.

COVERAGE — read the passage one sentence at a time and take every relation that
sentence states before moving on. Most sentences state more than one. "Aria
Vance founded Northwind Press in Leeds in 1998" states three — who founded it,
where it sits, when it began — and all three cite that one sentence. A quote may
be evidence for as many relations as it genuinely supports, so reuse it rather
than hunting for a narrower one each time.

Before you return, check every relation against the passage. Three things must
be true of each.
1. The quote is there letter for letter.
2. The quote spells out the name of its source or of its target.
3. Both source and target are names the passage writes out — never "the
   company", "a rival sequencer", "the two companies" or "the same grants". A
   bare noun is not an entity, and a relation with one on either end has to go.
   Nor may you swap in the nearest named thing of roughly the right kind. Apply
   the look-it-up test to both ends, article or no article: "field programme"
   and "regulators" fail it exactly as "the field programme" does.
Fix a failure of 1 or 2 by widening the quote, never by dropping the relation —
downstream, a bad quote kills a claim the passage plainly makes. A failure of 3
is the one case where dropping is right.

Return the passage's whole structure — every relation it asserts, and none it
does not.`

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

    // The passage goes in bare. A trailing "quote wide enough to name an
    // endpoint" reminder was measured and reverted: reading as a *minimum*
    // width, it undid the system prompt's "copy the sentence whole" and tripled
    // the gate-drop rate. The recall instruction has to stay a whole-sentence
    // one, and there is nowhere to say that briefly enough to repeat here.
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
