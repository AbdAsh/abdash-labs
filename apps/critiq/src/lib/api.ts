import { supabase } from '@labs/platform'
import type { ReportSummary, ReviewResponse, StoredReport } from './types'

const critiq = () => supabase.schema('critiq')

/**
 * A failure with the server's status attached.
 *
 * The status is the whole point. A 429 and a 415 need different words and a
 * different button, and a bare `Error` collapses them into one red line — which
 * is what `describeError` exists to undo and what it needs this class to do.
 */
export class ReviewError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'ReviewError'
  }
}

/** Runs a review. The Edge Function is the only thing that ever fetches a URL. */
export async function requestReview(url: string): Promise<ReviewResponse> {
  const { data, error } = await supabase.functions.invoke<ReviewResponse>('critiq-review', {
    body: { url },
  })
  if (error) throw await asReviewError(error)
  if (!data) throw new ReviewError('The review returned no data.')
  return data
}

/**
 * Opens a permalink. Goes through `report_by_slug` rather than a table select
 * because the table has no public read policy — that is what stops one user
 * enumerating another's audit history.
 */
export async function loadReport(slug: string): Promise<StoredReport | null> {
  const { data, error } = await critiq().rpc('report_by_slug', { p_slug: slug })
  if (error) throw new ReviewError(error.message)
  const rows = (data ?? []) as StoredReport[]
  return rows[0] ?? null
}

/** The caller's own reports. RLS scopes this to `auth.uid()`; no filter needed. */
export async function listMyReports(limit = 20): Promise<ReportSummary[]> {
  const { data, error } = await critiq()
    .from('reports')
    .select('slug, url, grades, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new ReviewError(error.message)
  return (data ?? []) as ReportSummary[]
}

/**
 * True when the current user owns this report. The permalink function does not
 * return `owner_id`, so ownership is established by whether RLS lets the caller
 * see the row at all.
 */
export async function ownsReport(slug: string): Promise<boolean> {
  const { data } = await critiq().from('reports').select('id').eq('slug', slug).maybeSingle()
  return data !== null && data !== undefined
}

/** Reports are public, so being able to take one down is part of the deal. */
export async function deleteReport(slug: string): Promise<void> {
  const { error } = await critiq().from('reports').delete().eq('slug', slug)
  if (error) throw new ReviewError(error.message)
}

/**
 * Edge Function errors arrive as an opaque `FunctionsHttpError` whose useful
 * text is in the response body. Without this every failure reads "Edge Function
 * returned a non-2xx status code", which tells a user nothing about their quota
 * being spent or their URL being refused.
 *
 * The response is cloned before reading: the caller may still want the body,
 * and a `Response` can only be consumed once.
 */
async function asReviewError(error: unknown): Promise<ReviewError> {
  const context = (error as { context?: unknown }).context
  const fallback = error instanceof Error ? error.message : String(error)

  if (context instanceof Response) {
    try {
      const body = await context.clone().json()
      const message = typeof body?.error === 'string' && body.error !== '' ? body.error : fallback
      return new ReviewError(message, context.status)
    } catch {
      return new ReviewError(fallback, context.status)
    }
  }

  return new ReviewError(fallback)
}
