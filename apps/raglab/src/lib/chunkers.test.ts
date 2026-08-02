import { describe, it, expect } from 'vitest'
import { CHUNKERS, chunkWith, joinPages, type ChunkerId } from './chunkers'

const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.'

const ALL: ChunkerId[] = ['fixed', 'sentence-window', 'recursive']

const prose = [
  'The first paragraph opens the document. It has two sentences.',
  '',
  'A second paragraph follows after a blank line. It carries three sentences. The last one ends here.',
  '',
  'Finally a third paragraph, which contains one extremely long unbroken run of characters '
    + 'that cannot be split on any sentence boundary at all because it simply keeps going and '
    + 'going without a single terminator until the very end of the document itself.',
].join('\n')

describe('span accounting', () => {
  // If this fails, every downstream metric is meaningless: gold spans are
  // character ranges into the full text, so a chunk whose offsets do not slice
  // back to its own content makes overlap uncomputable.
  it('produces offsets that slice back to the chunk content', () => {
    for (const id of ALL) {
      for (const c of chunkWith(id, text, { size: 30, overlap: 10 })) {
        expect(text.slice(c.start, c.end)).toBe(c.content)
      }
    }
  })

  it('round-trips on multi-paragraph prose at several sizes', () => {
    for (const id of ALL) {
      for (const size of [24, 60, 140, 400]) {
        const chunks = chunkWith(id, prose, { size, overlap: Math.floor(size / 4) })
        expect(chunks.length).toBeGreaterThan(0)
        for (const c of chunks) expect(prose.slice(c.start, c.end)).toBe(c.content)
      }
    }
  })

  it('covers the whole document with no gap between consecutive chunks', () => {
    const cs = chunkWith('fixed', text, { size: 30, overlap: 0 })
    expect(cs[0]!.start).toBe(0)
    expect(cs[cs.length - 1]!.end).toBe(text.length)
    for (let i = 1; i < cs.length; i++) expect(cs[i]!.start).toBeLessThanOrEqual(cs[i - 1]!.end)
  })

  it('covers every character of the document for all three families', () => {
    for (const id of ALL) {
      const cs = chunkWith(id, prose, { size: 80, overlap: 0 })
      expect(cs[0]!.start).toBe(0)
      expect(cs[cs.length - 1]!.end).toBe(prose.length)
      for (let i = 1; i < cs.length; i++) expect(cs[i]!.start).toBeLessThanOrEqual(cs[i - 1]!.end)
    }
  })

  it('overlaps by roughly the requested amount', () => {
    const cs = chunkWith('fixed', text, { size: 30, overlap: 10 })
    expect(cs[0]!.end - cs[1]!.start).toBeGreaterThan(5)
  })

  it('sentence-window never splits mid-sentence', () => {
    for (const c of chunkWith('sentence-window', text, { size: 40, overlap: 0 })) {
      expect(c.content.trim()).toMatch(/[.!?]$/)
    }
  })

  it('always makes forward progress and terminates', () => {
    for (const id of ALL) {
      const cs = chunkWith(id, prose, { size: 20, overlap: 19 })
      for (let i = 1; i < cs.length; i++) {
        expect(cs[i]!.start).toBeGreaterThan(cs[i - 1]!.start)
        expect(cs[i]!.end).toBeGreaterThan(cs[i - 1]!.end)
      }
    }
  })

  it('numbers chunks sequentially from zero', () => {
    for (const id of ALL) {
      const cs = chunkWith(id, prose, { size: 60, overlap: 10 })
      expect(cs.map((c) => c.index)).toEqual(cs.map((_, i) => i))
    }
  })

  it('returns nothing for empty or whitespace-only input', () => {
    for (const id of ALL) {
      expect(chunkWith(id, '', { size: 30, overlap: 0 })).toEqual([])
      expect(chunkWith(id, '   \n\n  ', { size: 30, overlap: 0 })).toEqual([])
    }
  })

  it('emits a single chunk when the document is shorter than the window', () => {
    for (const id of ALL) {
      const cs = chunkWith(id, 'Short.', { size: 500, overlap: 100 })
      expect(cs).toHaveLength(1)
      expect(cs[0]).toMatchObject({ start: 0, end: 6, content: 'Short.' })
    }
  })

  it('hard-wraps a sentence longer than the window rather than exceeding it', () => {
    const long = 'x'.repeat(250) + '.'
    for (const id of ALL) {
      for (const c of chunkWith(id, long, { size: 50, overlap: 0 })) {
        expect(c.end - c.start).toBeLessThanOrEqual(50)
      }
    }
  })

  it('rejects parameters that cannot make progress', () => {
    expect(() => chunkWith('fixed', text, { size: 30, overlap: 30 })).toThrow(/overlap/i)
    expect(() => chunkWith('fixed', text, { size: 0, overlap: 0 })).toThrow(/size/i)
  })

  it('exposes one label per chunker id', () => {
    expect(CHUNKERS.map((c) => c.id).sort()).toEqual([...ALL].sort())
  })
})

describe('page attribution', () => {
  it('joins pages into one text and reports where each begins', () => {
    const { text: joined, pageStarts } = joinPages([
      { page: 1, text: 'First page.' },
      { page: 2, text: 'Second page.' },
    ])
    expect(joined.slice(0, 11)).toBe('First page.')
    expect(pageStarts).toHaveLength(2)
    expect(pageStarts[0]).toBe(0)
    expect(joined.slice(pageStarts[1]!, pageStarts[1]! + 12)).toBe('Second page.')
  })

  it('assigns each chunk the page its first character falls on', () => {
    const { text: joined, pageStarts } = joinPages([
      { page: 1, text: 'a'.repeat(100) },
      { page: 2, text: 'b'.repeat(100) },
    ])
    const cs = chunkWith('fixed', joined, { size: 50, overlap: 0 }, pageStarts)
    expect(cs[0]!.page).toBe(1)
    expect(cs[cs.length - 1]!.page).toBe(2)
  })

  it('defaults every chunk to page 1 when no page map is supplied', () => {
    for (const c of chunkWith('fixed', text, { size: 30, overlap: 0 })) {
      expect(c.page).toBe(1)
    }
  })
})
