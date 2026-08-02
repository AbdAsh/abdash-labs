import { describe, it, expect } from 'vitest'
import { MAX_PAGES, estimateCost, formatUsd } from './cost'

/** ~2500 characters, the coarse chunk size GraphRead asks doc-core for. */
const chunk = (n = 2500) => 'x'.repeat(n)

describe('estimateCost', () => {
  it('costs nothing for an empty document', () => {
    const e = estimateCost([], 0)
    expect(e.chunks).toBe(0)
    expect(e.usd).toBe(0)
  })

  it('scales linearly with chunk count', () => {
    const one = estimateCost([chunk()], 1)
    const ten = estimateCost(Array.from({ length: 10 }, () => chunk()), 10)
    expect(ten.usd).toBeCloseTo(one.usd * 10, 6)
  })

  it('puts a 40-page document in single-digit cents', () => {
    // 40 pages at ~2500 chars a page is ~40 coarse chunks.
    const e = estimateCost(Array.from({ length: 40 }, () => chunk()), 40)
    expect(e.usd).toBeGreaterThan(0.001)
    expect(e.usd).toBeLessThan(0.1)
  })

  it('flags a document over the page cap', () => {
    expect(estimateCost([chunk()], MAX_PAGES).overPageCap).toBe(false)
    expect(estimateCost([chunk()], MAX_PAGES + 1).overPageCap).toBe(true)
  })

  it('counts a longer chunk as more input tokens', () => {
    const short = estimateCost([chunk(500)], 1)
    const long = estimateCost([chunk(5000)], 1)
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens)
  })

  it('charges the fixed prompt overhead once per chunk', () => {
    // Two empty chunks still cost something: the system prompt goes with each call.
    const e = estimateCost(['', ''], 1)
    expect(e.inputTokens).toBeGreaterThan(0)
  })

  it('never produces a negative or non-finite figure', () => {
    for (const e of [estimateCost([], -5), estimateCost([chunk()], 0)]) {
      expect(Number.isFinite(e.usd)).toBe(true)
      expect(e.usd).toBeGreaterThanOrEqual(0)
      expect(e.inputTokens).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('formatUsd', () => {
  it('never rounds a real cost down to free', () => {
    expect(formatUsd(0.0001)).toBe('< $0.01')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('shows cents for a normal run', () => {
    expect(formatUsd(0.034)).toBe('$0.03')
    expect(formatUsd(1.5)).toBe('$1.50')
  })
})
