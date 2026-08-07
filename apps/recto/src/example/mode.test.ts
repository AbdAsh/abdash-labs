import { describe, expect, it } from 'vitest'
import { modeFrom } from './mode'

describe('modeFrom', () => {
  it('shows the example to someone arriving with nothing', () => {
    expect(modeFrom('', null)).toBe('example')
  })

  it('honours the query parameter', () => {
    expect(modeFrom('?mode=live', null)).toBe('live')
    expect(modeFrom('?mode=example', 'live')).toBe('example')
  })

  // Linking GitHub sends the browser to the provider and back to
  // `origin + pathname` — the query string does not survive the round trip. The
  // stored value is the only thing that stops a sign-in from dumping the visitor
  // back onto the recording.
  it('falls back to what the visitor last chose when the URL says nothing', () => {
    expect(modeFrom('', 'live')).toBe('live')
    expect(modeFrom('?foo=bar', 'live')).toBe('live')
  })

  it('ignores anything that is not one of the two modes', () => {
    expect(modeFrom('?mode=admin', null)).toBe('example')
    expect(modeFrom('?mode=', 'live')).toBe('live')
    expect(modeFrom('', 'LIVE')).toBe('example')
    expect(modeFrom('', '{"mode":"live"}')).toBe('example')
  })

  it('takes a search string with or without its question mark', () => {
    expect(modeFrom('mode=live', null)).toBe('live')
  })
})
