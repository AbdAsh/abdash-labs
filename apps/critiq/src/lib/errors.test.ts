import { describe, expect, it } from 'vitest'
import { describeError } from './errors'

describe('describeError', () => {
  it('offers the GitHub link, and only that, on a spent quota', () => {
    const quota = describeError({
      status: 429,
      message: 'Daily limit reached for critiq:reviews. Sign in to raise your limit.',
    })
    expect(quota.action).toBe('link-github')
    expect(quota.title).toMatch(/reviews for today/i)
    // Retrying a spent quota is the one thing that cannot work.
    expect(quota.action).not.toBe('retry')
  })

  it('recognises a spent quota from the message when the status is missing', () => {
    expect(describeError({ message: 'Daily limit reached for critiq:reviews.' }).action)
      .toBe('link-github')
  })

  it('explains a non-HTML URL without implying the user did something wrong', () => {
    const pdf = describeError({
      status: 415,
      message: 'Critiq reviews web pages, and this URL returned application/pdf.',
    })
    expect(pdf.title).toMatch(/not a web page/i)
    expect(pdf.action).toBe('none')
    expect(pdf.detail).toMatch(/HTML/)
  })

  it('explains an SSRF refusal as a reachability limit, with the reason', () => {
    const blocked = describeError({
      status: 400,
      message: 'Refusing to fetch this URL: 10.0.0.5 is a private or reserved address',
    })
    expect(blocked.title).toMatch(/cannot be reviewed from here/i)
    expect(blocked.detail).toMatch(/public internet/i)
    // Retrying a blocked address never helps.
    expect(blocked.action).toBe('none')
    // The server's own words survive rather than being replaced.
    expect(blocked.raw).toContain('10.0.0.5')
  })

  it('offers a retry for a timeout and for a server fault, since both can be transient', () => {
    expect(describeError({ status: 500, message: 'Signal timed out.' }).action).toBe('retry')
    expect(describeError({ status: 502, message: 'Bad gateway' }).action).toBe('retry')
    expect(describeError({ message: 'Failed to fetch' }).action).toBe('retry')
  })

  it('tells an expired session to reload rather than to retry the review', () => {
    const expired = describeError({ status: 401, message: 'Invalid session' })
    expect(expired.title).toMatch(/session expired/i)
    expect(expired.detail).toMatch(/reload/i)
  })

  it('passes a plain 400 through in the server\'s own words', () => {
    const bad = describeError({ status: 400, message: 'A url is required' })
    expect(bad.detail).toBe('A url is required')
    expect(bad.action).toBe('none')
  })

  it('never returns an empty title or detail, whatever it is handed', () => {
    for (
      const input of [
        null,
        undefined,
        {},
        { status: null, message: null },
        { status: 0, message: '' },
        { message: '   ' },
      ]
    ) {
      const described = describeError(input)
      expect(described.title.length).toBeGreaterThan(0)
      expect(described.detail.length).toBeGreaterThan(0)
    }
  })

  it('distinguishes every failure mode the function can produce', () => {
    // The point of the module: six different failures, six different responses.
    const titles = new Set(
      [
        { status: 429, message: 'Daily limit reached for critiq:reviews.' },
        { status: 415, message: 'Critiq reviews web pages, and this URL returned image/png.' },
        { status: 400, message: 'Refusing to fetch this URL: localhost is an internal hostname' },
        { status: 401, message: 'Invalid session' },
        { status: 500, message: 'Signal timed out.' },
        { status: 400, message: 'A url is required' },
      ].map((e) => describeError(e).title),
    )
    expect(titles.size).toBe(6)
  })
})
