import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('@labs/platform', () => ({
  supabase: { auth: { getSession } },
  SUPABASE_URL: 'http://localhost',
}))

import { callFunction, functionError } from './functions'

/** Only the two members `functionError` touches, so a test cannot accidentally
 *  pass by leaning on some other part of a real Response. */
function failure(status: number, body: string): Response {
  return { status, text: async () => body } as Response
}

describe('callFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-abc' } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('attaches the session JWT', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    await callFunction('recto-chat', { question: 'q' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost/functions/v1/recto-chat')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc')
    expect(JSON.parse(init.body as string)).toEqual({ question: 'q' })
  })

  it('refuses before the network when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(callFunction('recto-chat', {})).rejects.toThrow(/session/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('functionError', () => {
  // Every function in this repo answers a failure with {"error": "..."}, and
  // that sentence is already written for a reader.
  it('uses the function’s own sentence verbatim', async () => {
    const message = await functionError(
      failure(409, '{"error":"This document is already in the notebook."}'),
    )
    expect(message).toBe('This document is already in the notebook.')
  })

  it('does not bolt a status code onto a sentence written for a person', async () => {
    expect(await functionError(failure(404, '{"error":"That notebook no longer exists."}'))).toBe(
      'That notebook no longer exists.',
    )
  })

  it('keeps status and body when the body did not come from our code', async () => {
    const message = await functionError(failure(502, 'upstream connect error'))
    expect(message).toContain('502')
    expect(message).toContain('upstream connect error')
  })

  it('falls back to the status alone for an empty body', async () => {
    expect(await functionError(failure(504, '   '))).toBe('The server returned 504.')
  })

  it('ignores JSON that carries no error string', async () => {
    const message = await functionError(failure(500, '{"ok":false}'))
    expect(message).toContain('500')
  })

  // A gateway's HTML error page is thousands of characters of markup; pasting
  // it whole into the interface is not an error message.
  it('truncates a runaway body', async () => {
    const message = await functionError(failure(500, 'x'.repeat(5000)))
    expect(message.length).toBeLessThan(300)
    expect(message).toMatch(/…$/)
  })

  it('survives a body that cannot be read at all', async () => {
    const res = {
      status: 500,
      text: async () => {
        throw new Error('stream already consumed')
      },
    } as unknown as Response
    expect(await functionError(res)).toBe('The server returned 500.')
  })
})
