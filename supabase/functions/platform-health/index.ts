import { preflight, jsonResponse, errorResponse } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/auth.ts'

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre
  try {
    // Touch Postgres — an Edge Function invocation alone may not count as
    // database activity for the inactivity timer. One of only two legitimate
    // serviceClient() call sites: the cron has no caller to act as.
    const db = serviceClient()
    const { error } = await db.schema('platform').from('quota_limits').select('app').limit(1)
    if (error) throw error
    return jsonResponse({ ok: true, ts: new Date().toISOString() })
  } catch (e) {
    return errorResponse(e)
  }
})
