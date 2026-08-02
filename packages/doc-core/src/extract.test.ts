import { describe, it, expect } from 'vitest'
import { splitPlainText } from './extract'

describe('splitPlainText', () => {
  it('wraps text as a single page', () => {
    expect(splitPlainText('hello')).toEqual([{ page: 1, text: 'hello' }])
  })
  it('handles empty input', () => {
    expect(splitPlainText('')).toEqual([{ page: 1, text: '' }])
  })
})
