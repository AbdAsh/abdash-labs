import { describe, it, expect } from 'vitest'
import { chunkPages } from './chunk'

describe('chunkPages', () => {
  it('returns one chunk for short text', () => {
    const chunks = chunkPages([{ page: 1, text: 'hello world' }])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ content: 'hello world', page: 1, index: 0 })
  })

  it('caps chunk length at maxChars', () => {
    const long = 'a '.repeat(2000) // 4000 chars
    const chunks = chunkPages([{ page: 1, text: long }], { maxChars: 1600, overlapChars: 320 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1600)
  })

  it('overlaps consecutive chunks', () => {
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ')
    const chunks = chunkPages([{ page: 1, text: words }], { maxChars: 1600, overlapChars: 320 })
    // Assert the precondition rather than reaching past it with `!`: under
    // noUncheckedIndexedAccess an indexed read is possibly-undefined, and if this
    // input ever stopped producing two chunks the overlap assertion below would
    // be vacuous instead of failing.
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    const [first, second] = chunks as [(typeof chunks)[number], (typeof chunks)[number]]
    const tail = first.content.slice(-100)
    expect(second.content).toContain(tail.trim().split(' ').pop())
  })

  it('preserves page numbers and skips blank pages', () => {
    const chunks = chunkPages([
      { page: 1, text: 'first page text' },
      { page: 2, text: '   ' },
      { page: 3, text: 'third page text' },
    ])
    expect(chunks.map((c) => c.page)).toEqual([1, 3])
  })

  it('assigns sequential unique indices', () => {
    const long = 'word '.repeat(2000)
    const chunks = chunkPages([{ page: 1, text: long }], { maxChars: 1600, overlapChars: 320 })
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })

  it('never silently drops non-empty input under degenerate opts', () => {
    const text = 'word '.repeat(500)
    // maxChars <= 0 would zero out every slice without clamping
    const zero = chunkPages([{ page: 1, text }], { maxChars: 0, overlapChars: 0 })
    expect(zero.length).toBeGreaterThan(0)
    // overlap >= maxChars would stall to 1-char advances without clamping
    const stall = chunkPages([{ page: 1, text }], { maxChars: 100, overlapChars: 500 })
    expect(stall.length).toBeGreaterThan(0)
    for (const c of stall) expect(c.content.length).toBeLessThanOrEqual(100)
    expect(stall.length).toBeLessThan(text.length) // not one-char-per-chunk
  })
})
