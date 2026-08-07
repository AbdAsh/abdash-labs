import { describe, expect, it } from 'vitest'
import { BASE, examplePath, parseRoute, reportPath, submitPath } from './router'

describe('parseRoute', () => {
  it('reads the landing page with or without a trailing slash', () => {
    expect(parseRoute(BASE)).toEqual({ name: 'submit' })
    expect(parseRoute(`${BASE}/`)).toEqual({ name: 'submit' })
  })

  it('reads a report permalink', () => {
    expect(parseRoute(`${BASE}/r/mzrg97xmbfht`)).toEqual({
      name: 'report',
      slug: 'mzrg97xmbfht',
    })
  })

  it('reads a saved example, with and without an id', () => {
    expect(parseRoute(`${BASE}/example`)).toEqual({ name: 'example', id: null })
    expect(parseRoute(`${BASE}/example/`)).toEqual({ name: 'example', id: null })
    expect(parseRoute(`${BASE}/example/js-only`)).toEqual({ name: 'example', id: 'js-only' })
  })

  it('does not confuse an example with a report', () => {
    // The example is a file in the bundle. Routing it through `/r/` would send
    // it to the database, where it does not exist, and 404 the one page that
    // must always render.
    expect(parseRoute(`${BASE}/r/example`)).toEqual({ name: 'report', slug: 'example' })
    expect(parseRoute(`${BASE}/example`).name).toBe('example')
  })

  it('falls back to the landing page for anything else', () => {
    expect(parseRoute(`${BASE}/nonsense`)).toEqual({ name: 'submit' })
    expect(parseRoute(`${BASE}/r/`)).toEqual({ name: 'submit' })
  })

  it('does not claim another app on the same origin', () => {
    // Every lab app is served from a path on one origin, so a router that
    // matched segments without checking the prefix would answer for its
    // neighbours' URLs.
    expect(parseRoute('/raglab/example')).toEqual({ name: 'submit' })
    expect(parseRoute('/raglab/r/abc')).toEqual({ name: 'submit' })
    expect(parseRoute('/')).toEqual({ name: 'submit' })
  })

  it('decodes a percent-encoded segment without throwing on a broken one', () => {
    expect(parseRoute(`${BASE}/example/js%2Donly`)).toEqual({ name: 'example', id: 'js-only' })
    expect(parseRoute(`${BASE}/example/%E0%A4%A`)).toEqual({ name: 'example', id: '%E0%A4%A' })
  })
})

describe('path builders', () => {
  it('round-trips through parseRoute', () => {
    expect(parseRoute(submitPath())).toEqual({ name: 'submit' })
    expect(parseRoute(reportPath('abc123'))).toEqual({ name: 'report', slug: 'abc123' })
    expect(parseRoute(examplePath('self-audit'))).toEqual({
      name: 'example',
      id: 'self-audit',
    })
    expect(parseRoute(examplePath())).toEqual({ name: 'example', id: null })
  })

  it('keeps every path under the app prefix', () => {
    for (const path of [submitPath(), reportPath('x'), examplePath(), examplePath('y')]) {
      expect(path.startsWith(`${BASE}/`)).toBe(true)
    }
  })

  it('encodes an id that would otherwise change the shape of the URL', () => {
    expect(examplePath('a/b')).toBe(`${BASE}/example/a%2Fb`)
  })
})
