import { describe, it, expect } from 'vitest'
import { requireEnv } from './env'

describe('requireEnv', () => {
  it('returns the value when set', () => {
    expect(requireEnv('X', { X: 'hello' })).toBe('hello')
  })

  it('throws a named error when missing', () => {
    expect(() => requireEnv('MISSING', {})).toThrow(/MISSING/)
  })

  it('throws when the value is an empty string', () => {
    expect(() => requireEnv('EMPTY', { EMPTY: '' })).toThrow(/EMPTY/)
  })
})
