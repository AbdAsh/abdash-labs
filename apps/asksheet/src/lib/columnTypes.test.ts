import { describe, expect, it } from 'vitest'
import {
  assertSupportedType,
  isSupportedType,
  SUPPORTED_TYPES,
  typeFamily,
  UnsupportedTypeError,
} from './columnTypes'

describe('assertSupportedType', () => {
  it('accepts every advertised type', () => {
    for (const type of SUPPORTED_TYPES) {
      expect(assertSupportedType(type)).toBe(type)
    }
  })

  it('upper-cases what it returns', () => {
    expect(assertSupportedType('date')).toBe('DATE')
  })

  it('rejects anything else, which is what stops type-name injection', () => {
    for (const hostile of ['VARCHAR); drop table data --', 'INT8', '', 'ANY']) {
      expect(() => assertSupportedType(hostile)).toThrow(UnsupportedTypeError)
    }
  })

  it('has a non-throwing companion', () => {
    expect(isSupportedType('bigint')).toBe(true)
    expect(isSupportedType('bigintt')).toBe(false)
  })
})

describe('typeFamily', () => {
  const cases: [string, string][] = [
    ['BIGINT', 'number'],
    ['INTEGER', 'number'],
    ['DOUBLE', 'number'],
    ['DECIMAL(18,4)', 'number'],
    ['HUGEINT', 'number'],
    ['UINTEGER', 'number'],
    ['DATE', 'date'],
    ['TIMESTAMP WITH TIME ZONE', 'date'],
    ['TIME', 'date'],
    ['BOOLEAN', 'boolean'],
    ['VARCHAR', 'text'],
    ['BLOB', 'text'],
    ['STRUCT(a INTEGER)', 'text'],
  ]

  for (const [input, expected] of cases) {
    it(`maps ${input} to ${expected}`, () => {
      expect(typeFamily(input)).toBe(expected)
    })
  }
})
