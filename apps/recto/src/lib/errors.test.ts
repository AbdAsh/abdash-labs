import { describe, it, expect } from 'vitest'
import { say } from './errors'

describe('say', () => {
  it('prefers an Error’s message', () => {
    expect(say(new Error('This document is already in the notebook.'))).toBe(
      'This document is already in the notebook.',
    )
  })

  it('keeps a subclass message', () => {
    class QuotaExceededError extends Error {}
    expect(say(new QuotaExceededError('Daily limit reached for recto:notebooks.'))).toBe(
      'Daily limit reached for recto:notebooks.',
    )
  })

  // The whole point. A raw PostgREST failure is a plain object, and String()
  // renders it as the two least useful words in the language.
  it('never shows the user [object Object]', () => {
    const postgrestError = {
      message: 'permission denied',
      details: '',
      hint: null,
      code: '42501',
    }
    expect(say(postgrestError)).not.toContain('[object Object]')
    expect(say(postgrestError)).toBe('Something went wrong.')
  })

  it('falls back for an Error with an empty message', () => {
    expect(say(new Error(''))).toBe('Error')
  })

  it('passes a plain string through', () => {
    expect(say('offline')).toBe('offline')
  })

  it('handles null and undefined', () => {
    expect(say(null)).toBe('null')
    expect(say(undefined)).toBe('undefined')
  })
})
