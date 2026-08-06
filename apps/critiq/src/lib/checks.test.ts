import { describe, expect, it } from 'vitest'
import { CHECK_LABELS, coverageLabel, passedChecks } from './checks'
import { DIMENSIONS } from './format'

describe('the check catalogue', () => {
  it('has a unique id and a passing sentence for every entry', () => {
    const ids = CHECK_LABELS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const check of CHECK_LABELS) {
      expect(check.passed.trim().length).toBeGreaterThan(0)
      expect(check.passed).not.toBe(check.id)
      expect(DIMENSIONS).toContain(check.dimension)
    }
  })
})

describe('passedChecks', () => {
  it('resolves ids to sentences in catalogue order, not the order they arrived', () => {
    const resolved = passedChecks(['viewport-missing', 'title-missing'])
    expect(resolved.map((c) => c.id)).toEqual(['title-missing', 'viewport-missing'])
    expect(resolved[0]?.passed).toBe('The page has a title')
  })

  it('keeps an id this build does not know about rather than dropping it', () => {
    // A server ahead of this deploy. Silently discarding the id would understate
    // how much of the page was actually verified.
    const resolved = passedChecks(['title-missing', 'some-future-check'])
    expect(resolved).toHaveLength(2)
    expect(resolved[1]?.id).toBe('some-future-check')
    expect(resolved[1]?.passed).toBe('some-future-check')
  })

  it('ignores duplicates and rubbish', () => {
    expect(passedChecks(['title-missing', 'title-missing'])).toHaveLength(1)
    expect(passedChecks(['', '  '])).toHaveLength(0)
    expect(passedChecks(null)).toEqual([])
    expect(passedChecks(undefined)).toEqual([])
  })
})

describe('coverageLabel', () => {
  it('counts against what ran, never against the size of the catalogue', () => {
    // A page with no images never had its alt coverage checked. Counting that
    // as a shortfall would mark the report down for work it correctly skipped.
    expect(coverageLabel(['title-missing', 'lang-missing'], 0)).toBe('2 of 2 mechanical checks passed')
    expect(coverageLabel(['title-missing', 'lang-missing'], 3)).toBe('2 of 5 mechanical checks passed')
  })

  it('reads correctly in the singular', () => {
    expect(coverageLabel(['title-missing'], 0)).toBe('1 of 1 mechanical check passed')
  })

  it('says so when nothing applied at all', () => {
    expect(coverageLabel([], 0)).toBe('No mechanical checks applied to this page')
  })

  it('handles a page where everything failed', () => {
    expect(coverageLabel([], 4)).toBe('0 of 4 mechanical checks passed')
  })
})
