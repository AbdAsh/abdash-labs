import { supabase, SUPABASE_URL } from '@labs/platform'

/**
 * The one way this app talks to an Edge Function.
 *
 * `supabase.functions.invoke` is avoided deliberately: it buffers the whole
 * response, which is fatal for the streamed chat, so both callers use `fetch`
 * and both need the same session token attached the same way. Having that in
 * one place is also what keeps the two from drifting on the "no session yet"
 * message the way the sibling apps have.
 */
export async function callFunction(name: string, body: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No session yet — sign-in has not finished.')

  return fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** An HTML error page from a gateway is not worth pasting into the interface
 *  whole, but its first line usually names the failure. */
const MAX_RAW_BODY = 200

/**
 * The sentence to show a person when a function refuses.
 *
 * Every function in this repo answers a failure with `{"error": "..."}`, and
 * that string is already written for a reader — so it is shown as written,
 * without a status code bolted on. Anything else did not come from our code
 * (a gateway timeout, a platform 502) and keeps both its status and its body,
 * because at that point the status is the only reliable clue.
 */
export async function functionError(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim()
  try {
    const parsed = JSON.parse(raw) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error
  } catch {
    // Not JSON — fall through to the status-and-body form below.
  }
  if (!raw) return `The server returned ${res.status}.`
  const body = raw.length > MAX_RAW_BODY ? `${raw.slice(0, MAX_RAW_BODY)}…` : raw
  return `The server returned ${res.status}: ${body}`
}
