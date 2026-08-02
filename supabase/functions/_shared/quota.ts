import { callerClient } from './auth.ts'

export class QuotaError extends Error {
  status = 429
  constructor(app: string, key: string) {
    super(`Daily limit reached for ${app}:${key}. Sign in to raise your limit.`)
    this.name = 'QuotaError'
  }
}

/** Consumes one unit of a daily rate limit, throwing 429 when exhausted.
 *  Runs as the caller so the RPC derives their tier from their own JWT — the
 *  elevation comes from SECURITY DEFINER inside Postgres, never from the
 *  service role. `.schema('platform')` is required: the client defaults to
 *  `public`, where `consume_quota` does not exist. */
export async function consumeQuota(
  jwt: string, app: string, key: string, amount = 1,
): Promise<void> {
  const { data, error } = await callerClient(jwt)
    .schema('platform')
    .rpc('consume_quota', { p_app: app, p_key: key, p_amount: amount })
  if (error) throw error
  if (data !== true) throw new QuotaError(app, key)
}
