import { supabase } from '@labs/platform'
import type { PlanRequest, PlanResponse } from './types'

/**
 * The one outbound call in the application.
 *
 * Everything in `request` was produced by `redactProfile`. If you are about to
 * add a field to what gets posted here, that is a change to the privacy contract
 * shown in the UI, and it needs to change there too.
 */

/** Mirrors the Edge Function's guard, so an oversized profile fails locally with
 *  a better message than a 413 from the other side of the network. */
export const MAX_REQUEST_BYTES = 32 * 1024

export class PlanRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'PlanRequestError'
    this.status = status
  }
}

export class PlanQuotaError extends PlanRequestError {
  constructor(message: string) {
    super(message, 429)
    this.name = 'PlanQuotaError'
  }
}

/** Supabase wraps non-2xx responses; the useful body is on `error.context`. */
async function unwrap(error: unknown): Promise<never> {
  const context = (error as { context?: Response })?.context
  if (context instanceof Response) {
    let message = `The planner returned ${context.status}.`
    try {
      const body = (await context.clone().json()) as { error?: string }
      if (typeof body.error === 'string' && body.error !== '') message = body.error
    } catch {
      /* non-JSON error body */
    }
    if (context.status === 429) throw new PlanQuotaError(message)
    throw new PlanRequestError(message, context.status)
  }
  throw new PlanRequestError(
    error instanceof Error ? error.message : 'The planner could not be reached.',
    0,
  )
}

export async function requestPlan(request: PlanRequest): Promise<PlanResponse> {
  const size = new TextEncoder().encode(JSON.stringify(request)).length
  if (size > MAX_REQUEST_BYTES) {
    throw new PlanRequestError(
      'This sheet has too many columns to describe in one request. Try a narrower extract.',
      413,
    )
  }

  const { data, error } = await supabase.functions.invoke<PlanResponse>('asksheet-plan', {
    body: request,
  })
  if (error) await unwrap(error)
  if (!data || typeof data.sql !== 'string') {
    throw new PlanRequestError('The planner returned an unusable response.', 502)
  }

  return {
    sql: data.sql,
    narration: typeof data.narration === 'string' ? data.narration : '',
    ...(data.chart && typeof data.chart === 'object' ? { chart: data.chart } : {}),
  }
}
