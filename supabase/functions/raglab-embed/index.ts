import { preflight, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { getCaller } from '../_shared/auth.ts'
import { consumeQuota } from '../_shared/quota.ts'
import { embed } from '../_shared/openai.ts'

/**
 * `raglab-embed` — batch OpenAI embedding proxy for RAG Lab.
 *
 * The only spend surface in the app, and the only server call a benchmark makes.
 * Everything else — chunking, ranking, scoring, caching — happens in the browser,
 * which is what keeps a twelve-config run off the shared database entirely.
 *
 * Request:  { texts: string[], model: 'text-embedding-3-small' | 'text-embedding-3-large',
 *             runId?: string }
 * Response: { vectors: number[][], runId: string }
 */

const ALLOWED_MODELS = new Set(['text-embedding-3-small', 'text-embedding-3-large'])

/** Mirrors the client-side caps in `apps/raglab/src/lib/embed.ts`. */
const MAX_TEXTS = 200
const MAX_CHARS = 400_000

/** A run token older than this is treated as absent and charged again. */
const RUN_TTL_MS = 60 * 60 * 1000

class BadRequest extends Error {
  status = 400
}

function runSecret(): string {
  // The service-role key never leaves the function; it is used here only as HMAC
  // key material, never to build a client. Quota still runs as the caller.
  return Deno.env.get('RAGLAB_RUN_SECRET')
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? 'raglab-dev-secret'
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(runSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Mints a run token bound to the caller and the moment it was issued.
 *
 * Quota is charged once per run rather than once per batch, so the token is what
 * stops a twelve-config benchmark from costing twelve of an anonymous visitor's
 * two daily runs. Signing it matters: an unsigned "have I already paid?" flag is
 * just a request field, and any client could send one forever.
 */
async function mintRunId(userId: string): Promise<string> {
  const body = `${userId}.${Date.now()}`
  return `${body}.${(await hmac(body)).slice(0, 32)}`
}

/** True only for a well-formed, unexpired token issued to this same caller. */
async function isValidRunId(runId: string, userId: string): Promise<boolean> {
  const parts = runId.split('.')
  if (parts.length !== 3) return false
  const [subject, issuedAt, signature] = parts as [string, string, string]
  if (subject !== userId) return false

  const issued = Number(issuedAt)
  if (!Number.isFinite(issued) || Date.now() - issued > RUN_TTL_MS || issued > Date.now()) {
    return false
  }
  const expected = (await hmac(`${subject}.${issuedAt}`)).slice(0, 32)
  if (expected.length !== signature.length) return false

  // Constant-time compare; a timing oracle here would leak the signing key byte
  // by byte, and the cost of doing it properly is one loop.
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

function parseBody(raw: unknown): { texts: string[]; model: string; runId?: string } {
  if (typeof raw !== 'object' || raw === null) throw new BadRequest('Body must be a JSON object')
  const { texts, model, runId } = raw as Record<string, unknown>

  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    throw new BadRequest('`texts` must be an array of strings')
  }
  if (texts.length === 0) throw new BadRequest('`texts` must not be empty')
  if (texts.length > MAX_TEXTS) {
    throw new BadRequest(`\`texts\` holds ${texts.length} items, above the cap of ${MAX_TEXTS}`)
  }

  const chars = (texts as string[]).reduce((n, t) => n + t.length, 0)
  if (chars > MAX_CHARS) {
    throw new BadRequest(`Request is ${chars} characters, above the cap of ${MAX_CHARS}`)
  }
  if (typeof model !== 'string' || !ALLOWED_MODELS.has(model)) {
    throw new BadRequest(`\`model\` must be one of: ${[...ALLOWED_MODELS].join(', ')}`)
  }
  if (runId !== undefined && typeof runId !== 'string') {
    throw new BadRequest('`runId` must be a string when present')
  }

  return { texts: texts as string[], model, runId: runId as string | undefined }
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const caller = await getCaller(req)
    const { texts, model, runId } = parseBody(await req.json())

    // Charge on the first batch only. A missing, malformed, expired or
    // someone-else's token all fail closed to "this is a new run".
    let activeRunId = runId
    const charging = !activeRunId || !(await isValidRunId(activeRunId, caller.userId))
    if (charging) {
      await consumeQuota(caller.jwt, 'raglab', 'runs', 1)
      activeRunId = await mintRunId(caller.userId)
    }

    let vectors: number[][]
    try {
      vectors = await embed(texts, model)
      if (vectors.length !== texts.length) {
        throw new Error(`OpenAI returned ${vectors.length} vectors for ${texts.length} texts`)
      }
    } catch (e) {
      // The gate has to come before the spend, or an over-quota caller gets a
      // free OpenAI call on every request. But a run that produced no vectors is
      // not a run, and an anonymous visitor has two a day — two upstream hiccups
      // would lock them out for the rest of it. So put the unit back.
      if (charging) {
        await consumeQuota(caller.jwt, 'raglab', 'runs', -1).catch(() => {})
      }
      throw e
    }

    // Vectors go back to the browser and stop there. Nothing in this function
    // writes an embedding to Postgres, and nothing ever should: the database is
    // 500 MB shared across seven apps and one benchmark is ~11 MB of floats.
    return jsonResponse({ vectors, runId: activeRunId })
  } catch (e) {
    return errorResponse(e)
  }
})
