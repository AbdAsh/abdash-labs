import { describe, it, expect } from 'vitest'
import { isRTL } from './rtl'

describe('isRTL', () => {
  it('detects Arabic', () => {
    expect(isRTL('هذا نص عربي طويل بما فيه الكفاية للكشف')).toBe(true)
  })

  it('detects Hebrew', () => {
    expect(isRTL('זהו משפט בעברית')).toBe(true)
  })

  it('rejects English', () => {
    expect(isRTL('This is an ordinary English sentence.')).toBe(false)
  })

  it('rejects Turkish, which is left-to-right despite the diacritics', () => {
    expect(isRTL('Bu bir Türkçe cümledir, sağdan sola değil.')).toBe(false)
  })

  it('ignores digits and punctuation when computing the ratio', () => {
    expect(isRTL('١٢٣ 456 ... !!!')).toBe(false)
  })

  it('detects a majority-Arabic mixed document', () => {
    expect(isRTL('تقرير سنوي عن الأنشطة والنتائج المالية (2026 Annual Report)')).toBe(true)
  })

  it('returns false for direction-neutral input', () => {
    expect(isRTL('')).toBe(false)
    expect(isRTL('2026 — 100% (n = 42)')).toBe(false)
  })

  it('honours an explicit threshold', () => {
    // Nine Latin letters to one Arabic letter: 10% RTL.
    const mostlyLatin = 'abcdefghi ا'
    expect(isRTL(mostlyLatin, 0.3)).toBe(false)
    expect(isRTL(mostlyLatin, 0.05)).toBe(true)
  })
})
