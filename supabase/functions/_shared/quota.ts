import { callerClient } from './auth.ts'

/** Which ceiling refused the request. Returned by `platform.consume_quota_status`. */
export type QuotaStatus =
  | 'ok'
  | 'user_limit'
  | 'global_limit'
  | 'unconfigured'
  | 'no_session'

export class QuotaError extends Error {
  status = 429
  constructor(
    readonly reason: Exclude<QuotaStatus, 'ok'>,
    app: string,
    key: string,
  ) {
    super(QuotaError.describe(reason, app, key))
    this.name = 'QuotaError'
  }

  /** The distinction is not cosmetic. Telling someone to sign in for a higher
   *  limit is actively wrong when the platform itself is out of budget — they
   *  would sign in and still get nothing. */
  private static describe(reason: string, app: string, key: string): string {
    switch (reason) {
      case 'user_limit':
        return `Daily limit reached for ${app}:${key}. Sign in to raise your limit.`
      case 'global_limit':
        return (
          `${app} has reached its daily limit across all visitors and will reset ` +
          'tomorrow. This is a spending cap on a personal project, not a fault ' +
          'with your request — signing in will not raise it.'
        )
      case 'unconfigured':
        return `No quota is configured for ${app}:${key}, so the request was refused.`
      case 'no_session':
        return 'No session. Reload the page to start one.'
      default:
        return `Request refused for ${app}:${key}.`
    }
  }
}

/**
 * Consumes one unit of a daily meter, throwing 429 when either ceiling is hit.
 *
 * Runs as the caller so the RPC derives their tier from their own JWT — the
 * function is SECURITY DEFINER, which is what lets it touch the counter tables
 * without the caller having any grant on them.
 */
export async function consumeQuota(
  jwt: string,
  app: string,
  key: string,
  amount = 1,
): Promise<void> {
  const { data, error } = await callerClient(jwt)
    .schema('platform')
    .rpc('consume_quota_status', { p_app: app, p_key: key, p_amount: amount })
  if (error) throw error

  const status = (data ?? 'unconfigured') as QuotaStatus
  if (status !== 'ok') throw new QuotaError(status, app, key)
}

/**
 * Returns a unit without failing the caller. Used for refunds — RAG Lab gives a
 * run back when the embedding provider errored before any vectors were bought,
 * so an upstream hiccup does not cost someone their allowance for the day.
 *
 * Deliberately swallows its own errors: a failed refund must never turn a
 * successful request into a failed one.
 */
export async function refundQuota(
  jwt: string,
  app: string,
  key: string,
  amount = 1,
): Promise<void> {
  try {
    await callerClient(jwt)
      .schema('platform')
      .rpc('consume_quota_status', { p_app: app, p_key: key, p_amount: -amount })
  } catch {
    /* a refund that fails is not worth failing the request over */
  }
}
