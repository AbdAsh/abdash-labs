/**
 * Edge Function errors, unwrapped.
 *
 * `supabase.functions.invoke` turns every non-2xx into a `FunctionsHttpError`
 * whose message is the constant string "Edge Function returned a non-2xx status
 * code". The text that matters — the quota refusal, the oversized chunk, the
 * model failure — is in the response body hanging off `error.context`.
 *
 * Leaving it wrapped is not a cosmetic problem. It makes "you have used today's
 * extraction allowance" indistinguishable from a network blip, so the run
 * cannot stop early on a quota rejection and instead burns sixty doomed
 * requests before showing the user nothing.
 */

export class FunctionError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'FunctionError'
    this.status = status
  }
}

/** A 429. Worth its own type because it ends the run rather than skipping a chunk. */
export class QuotaError extends FunctionError {
  constructor(message: string) {
    super(message, 429)
    this.name = 'QuotaError'
  }
}

/**
 * Reads the JSON body a Supabase function error is hiding and returns a typed
 * error. `clone()` matters: the body is a stream, and consuming it here would
 * leave nothing for anyone who looks again.
 */
export async function functionError(error: unknown, fallback: string): Promise<FunctionError> {
  const context = (error as { context?: unknown })?.context

  if (context instanceof Response) {
    let message = `${fallback} (HTTP ${context.status})`
    try {
      const body = (await context.clone().json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error !== '') message = body.error
    } catch {
      // A non-JSON body — an HTML gateway page, usually. Keep the fallback.
    }
    return context.status === 429
      ? new QuotaError(message)
      : new FunctionError(message, context.status)
  }

  // No response at all: DNS, CORS, offline.
  return new FunctionError(error instanceof Error ? error.message : fallback, 0)
}

/**
 * The `unknown → string` narrowing every catch site in the app needs.
 *
 * The naive `e instanceof Error ? e.message : String(e)` has a specific hole,
 * and it is the one that actually fires: PostgREST — every `error` supabase-js
 * hands back from a table call — is a plain object of the shape
 * `{ message, details, hint, code }`, not an `Error`. It falls to `String(e)`
 * and the user is shown the literal text `[object Object]`, which is both
 * useless and unmistakably a bug.
 */
export function say(e: unknown): string {
  if (typeof e === 'string') return e || 'Something went wrong.'
  if (e instanceof Error && e.message) return e.message

  if (e && typeof e === 'object') {
    const { message, details, hint } = e as Record<string, unknown>
    // `hint` last: PostgREST's hints are the only part written for a human.
    for (const field of [message, details, hint]) {
      if (typeof field === 'string' && field.trim() !== '') return field
    }
    return 'Something went wrong.'
  }

  const text = String(e)
  return text === '' || text === 'null' || text === 'undefined' ? 'Something went wrong.' : text
}
