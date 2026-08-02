import { getCaller } from '../_shared/auth.ts'
import { errorResponse, jsonResponse, preflight } from '../_shared/cors.ts'
import { chatJSON, type Message } from '../_shared/openrouter.ts'
import { consumeQuota } from '../_shared/quota.ts'

/**
 * asksheet-plan — the only server call AskSheet makes.
 *
 * It receives a *schema profile* and a question, and returns SQL plus an optional
 * Vega-Lite spec. It never receives rows, and there is nothing here that could
 * store them if it did: no table, no bucket, no log of request content.
 *
 * The request is re-validated and re-redacted server-side. The client already
 * redacts (see `src/lib/profile.ts`), but a server that trusts a client's promise
 * about a privacy boundary is not enforcing one — a tampered or stale client must
 * not be able to turn this endpoint into a data sink.
 */

/** Nothing legitimate comes close. 40 columns × 5 short samples is a few KB. */
const MAX_BODY_BYTES = 32 * 1024
const MAX_QUESTION_CHARS = 500
const MAX_HISTORY = 6
const MAX_SAMPLES = 5
const MAX_SAMPLE_CHARS = 64
const MAX_COLUMNS = 200

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sql', 'narration'],
  properties: {
    sql: {
      type: 'string',
      description: 'A single DuckDB SELECT statement. No semicolon-separated statements.',
    },
    narration: {
      type: 'string',
      description: 'One sentence framing the answer. No markdown.',
    },
    chart: {
      type: 'object',
      description:
        'Optional Vega-Lite spec referencing only columns the SQL returns. Omit when a table says it better.',
    },
  },
} as const

interface ProfileColumn {
  name: string
  type: string
  samples: string[]
}

interface Profile {
  table: string
  columns: ProfileColumn[]
  rowCount: number
}

class BadRequestError extends Error {
  status = 400
}

class PayloadTooLargeError extends Error {
  status = 413
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** Rebuilds the profile key by key. Anything the client sent that is not on this
 *  list simply does not exist as far as the model is concerned. */
function sanitizeProfile(input: unknown): Profile {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestError('A schema profile is required.')
  }
  const raw = input as Record<string, unknown>
  const columns = Array.isArray(raw.columns) ? raw.columns.slice(0, MAX_COLUMNS) : []
  if (columns.length === 0) throw new BadRequestError('The profile has no columns.')

  return {
    table: text(raw.table, 64) || 'data',
    rowCount:
      typeof raw.rowCount === 'number' && Number.isFinite(raw.rowCount) && raw.rowCount >= 0
        ? Math.floor(raw.rowCount)
        : 0,
    columns: columns.map((column) => {
      const record = (typeof column === 'object' && column !== null ? column : {}) as Record<
        string,
        unknown
      >
      const samples = Array.isArray(record.samples) ? record.samples : []
      return {
        name: text(record.name, 128),
        type: text(record.type, 64) || 'UNKNOWN',
        samples: samples
          .slice(0, MAX_SAMPLES)
          .map((sample) => text(typeof sample === 'string' ? sample : String(sample), MAX_SAMPLE_CHARS)),
      }
    }),
  }
}

interface PlanBody {
  profile: Profile
  history: { question: string; sql: string }[]
  question: string
  repair?: { sql: string; error: string }
}

function parseBody(raw: string): PlanBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BadRequestError('The request body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestError('The request body must be an object.')
  }
  const body = parsed as Record<string, unknown>

  const question = text(body.question, MAX_QUESTION_CHARS).trim()
  if (question === '') throw new BadRequestError('A question is required.')

  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-MAX_HISTORY)
    .map((turn) => {
      const record = (typeof turn === 'object' && turn !== null ? turn : {}) as Record<string, unknown>
      return { question: text(record.question, MAX_QUESTION_CHARS), sql: text(record.sql, 4000) }
    })
    .filter((turn) => turn.question !== '' && turn.sql !== '')

  const repairInput = body.repair
  const repair =
    typeof repairInput === 'object' && repairInput !== null
      ? {
          sql: text((repairInput as Record<string, unknown>).sql, 4000),
          error: text((repairInput as Record<string, unknown>).error, 1000),
        }
      : undefined

  return {
    profile: sanitizeProfile(body.profile),
    history,
    question,
    ...(repair && repair.sql !== '' ? { repair } : {}),
  }
}

function describeSchema(profile: Profile): string {
  return profile.columns
    .map((column) => {
      const examples = column.samples.length > 0 ? ` — e.g. ${column.samples.join(', ')}` : ''
      return `  ${column.name} ${column.type}${examples}`
    })
    .join('\n')
}

function systemPrompt(profile: Profile): string {
  const anySamples = profile.columns.some((column) => column.samples.length > 0)
  return [
    'You write DuckDB SQL for a table that lives entirely in the user\'s browser.',
    '',
    `Table: ${profile.table} (${profile.rowCount} rows)`,
    'Columns:',
    describeSchema(profile),
    '',
    anySamples
      ? 'The example values are a handful of distinct values per column, nothing more.'
      : 'The user enabled strict mode, so you are given no example values at all. Infer from names and types.',
    '',
    'Rules:',
    '1. Return exactly one statement. It must be a SELECT, or a WITH query ending in a SELECT.',
    '   No PRAGMA, COPY, ATTACH, INSTALL, LOAD, CREATE, INSERT, UPDATE, DELETE or DROP; the client',
    '   rejects those outright and the user sees an error instead of an answer.',
    '2. Never call read_csv, read_parquet, glob or any other function that reads a path or URL.',
    `   The data is already loaded as ${profile.table}.`,
    '3. Double-quote any identifier that collides with a SQL keyword, e.g. "call", "set", "order".',
    '4. Use DuckDB dialect and its conveniences: GROUP BY ALL, QUALIFY, strftime, try_cast,',
    '   date_trunc, and the FILTER clause on aggregates.',
    '5. Aggregate rather than dumping rows. If the question implies a ranking, ORDER BY and LIMIT.',
    '6. Cast text that holds numbers or dates with try_cast before doing arithmetic on it.',
    '7. narration is one plain sentence describing what the query answers. No markdown, no SQL.',
    '8. Include chart only when a picture beats a table — a trend, a distribution, or a comparison',
    '   across more than three categories. It must be a valid Vega-Lite v5 spec with no "data"',
    '   property (the client injects the result) and it may only reference columns your SQL returns.',
    '',
    'Earlier turns are given as question and SQL pairs so that follow-ups like "now only 2025"',
    'resolve. You are never given results, because results are the user\'s data and it does not',
    'leave their machine.',
  ].join('\n')
}

function userPrompt(body: PlanBody): string {
  const parts: string[] = []
  for (const turn of body.history) {
    parts.push(`Earlier question: ${turn.question}\nSQL you wrote: ${turn.sql}`)
  }
  parts.push(`Question: ${body.question}`)
  if (body.repair) {
    parts.push(
      [
        'Your previous SQL for this question failed. Fix it.',
        `SQL: ${body.repair.sql}`,
        `Error: ${body.repair.error}`,
        'Return a corrected single SELECT. Do not repeat the same mistake.',
      ].join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** Models occasionally wrap SQL in a fence even under a JSON schema. */
function cleanSql(sql: string): string {
  return sql
    .replace(/^\s*```(?:sql)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

interface PlanOutput {
  sql: string
  narration: string
  chart?: Record<string, unknown>
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    if (req.method !== 'POST') throw new BadRequestError('Use POST.')

    // Read as text first: the size guard has to happen before anything treats
    // this as a profile, or an oversized "profile" becomes a way to ship rows.
    const raw = await req.text()
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(
        'That schema profile is too large. AskSheet only sends column names, types and a few example values.',
      )
    }

    const body = parseBody(raw)
    const caller = await getCaller(req)
    await consumeQuota(caller.jwt, 'asksheet', 'plans')

    const messages: Message[] = [
      { role: 'system', content: systemPrompt(body.profile) },
      { role: 'user', content: userPrompt(body) },
    ]

    const output = await chatJSON<PlanOutput>(messages, SCHEMA, Deno.env.get('MODEL_CHEAP'))

    const sql = cleanSql(typeof output?.sql === 'string' ? output.sql : '')
    if (sql === '') throw new Error('The planner returned no SQL.')

    return jsonResponse({
      sql,
      narration:
        typeof output?.narration === 'string' && output.narration.trim() !== ''
          ? output.narration.trim()
          : 'Here is what that query returns.',
      ...(output?.chart && typeof output.chart === 'object' ? { chart: output.chart } : {}),
    })
  } catch (error) {
    // Deliberately no logging of question or profile content: the privacy note
    // promises transient function logs only, and this is where that is kept.
    return errorResponse(error)
  }
})
