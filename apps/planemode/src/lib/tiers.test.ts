import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_TIER_ID,
  TIERS,
  TIER_MEMORY_KEY,
  forgetTier,
  formatBytes,
  rememberTier,
  rememberedTier,
  tierById,
} from './tiers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TIERS', () => {
  it('pins an explicit model id, size and context window for every tier', () => {
    for (const tier of TIERS) {
      expect(tier.modelId).toMatch(/-MLC$/)
      expect(tier.approxBytes).toBeGreaterThan(100_000_000)
      expect(tier.contextWindow).toBeGreaterThan(0)
      expect(tier.weightsUrl).toMatch(/^https:\/\/huggingface\.co\//)
    }
  })

  // Cloudflare Pages caps files at 25 MiB, and self-serving gigabytes of weights
  // would be worse than impossible. The CDN URL is load-bearing, not decorative.
  it('sources every tier from the HuggingFace CDN, never this origin', () => {
    for (const tier of TIERS) expect(tier.weightsUrl).not.toMatch(/abdash|labs\./)
  })

  it('defaults to the smaller tier, because a failed download beats a smaller model', () => {
    expect(DEFAULT_TIER_ID).toBe('small')
    const small = tierById('small')
    for (const tier of TIERS) expect(small.approxBytes).toBeLessThanOrEqual(tier.approxBytes)
  })

  it('throws on an unknown tier rather than silently picking one', () => {
    expect(() => tierById('huge' as never)).toThrow(/Unknown model tier/)
  })
})

// The size is the single number a visitor decides on. Getting it visibly wrong
// — "704588843 bytes", "0.7 GB" for 700 MB — is what makes people close the tab.
describe('formatBytes', () => {
  it.each([
    [704_588_843, '705 MB'],
    [1_816_930_956, '1.82 GB'],
    [1_000_000_000, '1.00 GB'],
    [999_999_999, '1000 MB'],
    [245 * 1024 * 1024, '257 MB'],
    [512_000, '512 kB'],
  ])('formats %d as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('never renders a negative, NaN or infinite size', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(formatBytes(bad)).toBe('0 MB')
    }
  })
})

/** A localStorage stand-in; Node has none. */
function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void data.set(key, value)),
    removeItem: vi.fn((key: string) => void data.delete(key)),
  }
  vi.stubGlobal('localStorage', storage)
  return { storage, data }
}

describe('remembered tier', () => {
  it('round-trips the chosen tier', () => {
    stubStorage()

    rememberTier('mid')

    expect(rememberedTier()).toBe('mid')
  })

  it('has no memory on a first visit', () => {
    stubStorage()
    expect(rememberedTier()).toBeNull()
  })

  it('forgets on request, so a deleted model does not look half-downloaded', () => {
    stubStorage()
    rememberTier('small')

    forgetTier()

    expect(rememberedTier()).toBeNull()
  })

  // A tier id from an older build would otherwise reach tierById(), which throws
  // — turning a stale key into a blank page on boot.
  it('ignores a stored value that is not a tier this build knows', () => {
    stubStorage({ [TIER_MEMORY_KEY]: 'enormous' })
    expect(rememberedTier()).toBeNull()
  })

  it('survives a browser with no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(rememberedTier()).toBeNull()
    expect(() => rememberTier('small')).not.toThrow()
    expect(() => forgetTier()).not.toThrow()
  })

  it('survives a localStorage that throws, as private modes do', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })

    expect(rememberedTier()).toBeNull()
    expect(() => rememberTier('mid')).not.toThrow()
    expect(() => forgetTier()).not.toThrow()
  })
})
