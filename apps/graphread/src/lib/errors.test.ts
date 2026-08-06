import { describe, it, expect } from 'vitest'
import { functionError, FunctionError, QuotaError, say } from './errors'

/** What supabase-js hands you: a constant message, with the truth on `context`. */
const invokeError = (status: number, body: unknown) =>
  Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    context: new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  })

describe('functionError', () => {
  it('recovers the message the function actually sent', async () => {
    const e = await functionError(
      invokeError(429, { error: 'Daily limit reached for graphread:extractions. Sign in to raise your limit.' }),
      'fallback',
    )
    expect(e.message).toContain('Daily limit reached')
  })

  it('types a 429 so the run can stop instead of retrying fifty-nine more chunks', async () => {
    const e = await functionError(invokeError(429, { error: 'Daily limit reached.' }), 'fallback')
    expect(e).toBeInstanceOf(QuotaError)
    expect(e.status).toBe(429)
  })

  it('does not mistake another failure for a quota rejection', async () => {
    const e = await functionError(invokeError(500, { error: 'openrouter timed out' }), 'fallback')
    expect(e).toBeInstanceOf(FunctionError)
    expect(e).not.toBeInstanceOf(QuotaError)
    expect(e.status).toBe(500)
  })

  it('falls back with the status when the body is not JSON', async () => {
    const e = await functionError(invokeError(502, '<html>bad gateway</html>'), 'The extractor failed.')
    expect(e.message).toBe('The extractor failed. (HTTP 502)')
    expect(e.status).toBe(502)
  })

  it('leaves the body readable for anyone who looks again', async () => {
    const original = invokeError(429, { error: 'Daily limit reached.' })
    await functionError(original, 'fallback')
    await expect(original.context.json()).resolves.toEqual({ error: 'Daily limit reached.' })
  })

  it('reports a status of zero when the request never reached the function', async () => {
    const e = await functionError(new TypeError('Failed to fetch'), 'Unreachable.')
    expect(e.status).toBe(0)
    expect(e.message).toBe('Failed to fetch')
  })

  it('uses the fallback for a thrown non-error with no response', async () => {
    const e = await functionError({ nope: true }, 'The extractor could not be reached.')
    expect(e.message).toBe('The extractor could not be reached.')
  })
})

describe('say', () => {
  it('prefers an error message', () => {
    expect(say(new Error('boom'))).toBe('boom')
  })

  it('stringifies anything else', () => {
    expect(say('plain')).toBe('plain')
    expect(say(404)).toBe('404')
  })

  it('reads a PostgREST error, which is a plain object and not an Error', () => {
    // This is the shape every supabase-js table call returns on failure. Passed
    // to `String()` it renders as "[object Object]", which is what the naive
    // one-line narrowing does and what users actually saw.
    expect(
      say({
        message: 'new row violates row-level security policy for table "graphs"',
        details: null,
        hint: null,
        code: '42501',
      }),
    ).toBe('new row violates row-level security policy for table "graphs"')
  })

  it('falls through to details, then hint, when message is empty', () => {
    expect(say({ message: '', details: 'Key (slug) already exists.', hint: null })).toBe(
      'Key (slug) already exists.',
    )
    expect(say({ message: null, details: null, hint: 'Perhaps you meant the id column.' })).toBe(
      'Perhaps you meant the id column.',
    )
  })

  it('never shows the user [object Object]', () => {
    expect(say({ weird: true })).toBe('Something went wrong.')
    expect(say(new Error(''))).toBe('Something went wrong.')
    expect(say(null)).toBe('Something went wrong.')
    expect(say(undefined)).toBe('Something went wrong.')
    expect(say('')).toBe('Something went wrong.')
  })
})
