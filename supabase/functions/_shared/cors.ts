export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

/** Call first in every handler. Returns a response for OPTIONS, null otherwise. */
export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Turns anything thrown into a readable message.
 *
 *  `String(e)` is not enough. PostgREST and supabase-js reject with a plain
 *  `{ message, details, hint, code }` object rather than an Error, so the obvious
 *  `e instanceof Error ? e.message : String(e)` renders the literal text
 *  "[object Object]" — which is what the very first live request to this project
 *  returned, hiding the real failure underneath it. An error path that cannot
 *  report errors is worse than no error path, because it costs a debugging cycle
 *  every time instead of once. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown }
    const parts = [
      typeof o.message === 'string' ? o.message : null,
      typeof o.code === 'string' ? `(${o.code})` : null,
      typeof o.details === 'string' ? o.details : null,
      typeof o.hint === 'string' ? `Hint: ${o.hint}` : null,
    ].filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
    try {
      return JSON.stringify(e)
    } catch {
      /* fall through to the generic string below */
    }
  }
  return String(e)
}

export function errorResponse(e: unknown, status = 500): Response {
  const code = typeof (e as { status?: number })?.status === 'number'
    ? (e as { status: number }).status
    : status
  return jsonResponse({ error: describe(e) }, code)
}
