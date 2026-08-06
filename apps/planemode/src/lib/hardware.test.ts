import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  detectCapability,
  fitsInFreeSpace,
  MID_TIER_MIN_MEMORY_GB,
  MID_TIER_MIN_BUFFER_BYTES,
  SPACE_HEADROOM_BYTES,
} from './hardware'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A minimal stand-in for a GPUAdapter. Real adapters carry a `limits` bag; a
 *  bare stub deliberately does not, so the memory path can be tested alone. */
function stubNavigator(options: {
  gpu?: unknown
  deviceMemory?: unknown
  storage?: unknown
} = {}) {
  const nav: Record<string, unknown> = {}
  if ('gpu' in options) nav.gpu = options.gpu
  if ('deviceMemory' in options) nav.deviceMemory = options.deviceMemory
  if ('storage' in options) nav.storage = options.storage
  vi.stubGlobal('navigator', nav)
}

function estimating(usage: number, quota: number) {
  return { estimate: async () => ({ usage, quota }) }
}

function adapterYielding(adapter: unknown) {
  return { requestAdapter: vi.fn().mockResolvedValue(adapter) }
}

describe('detectCapability — no WebGPU', () => {
  it('reports webgpu false with no recommendation and a human-readable reason', async () => {
    stubNavigator({ deviceMemory: 16 })

    const cap = await detectCapability()

    expect(cap.webgpu).toBe(false)
    expect(cap.recommended).toBeNull()
    expect(typeof cap.reason).toBe('string')
    expect(cap.reason).toMatch(/WebGPU/i)
    // Human-readable means a sentence a visitor can act on, not an error code.
    expect(cap.reason!.length).toBeGreaterThan(40)
    expect(cap.reason).toMatch(/Chrome|Edge|browser/i)
  })

  it('still reports the memory it could read', async () => {
    stubNavigator({ deviceMemory: 16 })
    await expect(detectCapability()).resolves.toMatchObject({ approxMemoryGB: 16 })
  })

  it('treats a present navigator.gpu that yields no adapter as unsupported', async () => {
    stubNavigator({ gpu: adapterYielding(null), deviceMemory: 8 })

    const cap = await detectCapability()

    expect(cap.webgpu).toBe(false)
    expect(cap.recommended).toBeNull()
    expect(cap.reason).toMatch(/adapter/i)
  })

  it('treats a throwing requestAdapter as unsupported rather than crashing', async () => {
    stubNavigator({
      gpu: { requestAdapter: vi.fn().mockRejectedValue(new Error('GPU process crashed')) },
      deviceMemory: 8,
    })

    const cap = await detectCapability()

    expect(cap.webgpu).toBe(false)
    expect(cap.recommended).toBeNull()
    expect(cap.reason).toMatch(/GPU process crashed/)
  })

  it('survives navigator being absent entirely', async () => {
    vi.stubGlobal('navigator', undefined)
    await expect(detectCapability()).resolves.toMatchObject({
      webgpu: false,
      approxMemoryGB: null,
      recommended: null,
    })
  })
})

describe('detectCapability — tier recommendation', () => {
  it('recommends mid when an adapter is present and the device reports 8 GB', async () => {
    stubNavigator({ gpu: adapterYielding({}), deviceMemory: 8 })

    await expect(detectCapability()).resolves.toMatchObject({
      webgpu: true,
      approxMemoryGB: 8,
      recommended: 'mid',
    })
  })

  it('recommends small at 4 GB', async () => {
    stubNavigator({ gpu: adapterYielding({}), deviceMemory: 4 })

    await expect(detectCapability()).resolves.toMatchObject({
      webgpu: true,
      approxMemoryGB: 4,
      recommended: 'small',
    })
  })

  // The load-bearing case. Safari and Firefox do not expose deviceMemory at all.
  // Guessing high there means a visitor waits for two gigabytes and then hits an
  // out-of-memory failure, which is a far worse experience than a smaller model
  // that simply works.
  it('recommends small — not mid — when memory is unknown', async () => {
    stubNavigator({ gpu: adapterYielding({}) })

    const cap = await detectCapability()

    expect(cap.webgpu).toBe(true)
    expect(cap.approxMemoryGB).toBeNull()
    expect(cap.recommended).toBe('small')
    expect(cap.recommended).not.toBe('mid')
    expect(cap.reason).toMatch(/smaller|small/i)
  })

  it.each([
    [undefined],
    [null],
    ['8'],
    [Number.NaN],
    [0],
    [-4],
  ])('treats deviceMemory %p as unknown and falls back to small', async (deviceMemory) => {
    stubNavigator({ gpu: adapterYielding({}), deviceMemory })

    await expect(detectCapability()).resolves.toMatchObject({
      approxMemoryGB: null,
      recommended: 'small',
    })
  })

  it('downgrades to small when the adapter cannot allocate a big enough buffer', async () => {
    stubNavigator({
      gpu: adapterYielding({ limits: { maxBufferSize: 256 * 1024 * 1024 } }),
      deviceMemory: 8,
    })

    const cap = await detectCapability()

    expect(cap.recommended).toBe('small')
    expect(cap.reason).toMatch(/GPU/i)
  })

  it('keeps mid when the adapter reports a large enough buffer limit', async () => {
    stubNavigator({
      gpu: adapterYielding({ limits: { maxBufferSize: MID_TIER_MIN_BUFFER_BYTES } }),
      deviceMemory: 8,
    })

    await expect(detectCapability()).resolves.toMatchObject({ recommended: 'mid' })
  })

  it('exposes its thresholds so the UI can explain them', () => {
    expect(MID_TIER_MIN_MEMORY_GB).toBe(8)
    expect(MID_TIER_MIN_BUFFER_BYTES).toBeGreaterThan(0)
  })
})

describe('detectCapability — free space', () => {
  it('reports what the browser will still let this origin store', async () => {
    stubNavigator({ gpu: adapterYielding({}), deviceMemory: 8, storage: estimating(1e9, 21e9) })

    await expect(detectCapability()).resolves.toMatchObject({ freeBytes: 20e9 })
  })

  it('reports null rather than zero when the browser will not estimate', async () => {
    stubNavigator({ gpu: adapterYielding({}), deviceMemory: 8 })

    await expect(detectCapability()).resolves.toMatchObject({ freeBytes: null })
  })

  it('reports null when the estimate throws', async () => {
    stubNavigator({
      gpu: adapterYielding({}),
      deviceMemory: 8,
      storage: {
        estimate: async () => {
          throw new Error('SecurityError')
        },
      },
    })

    await expect(detectCapability()).resolves.toMatchObject({ freeBytes: null })
  })

  it('never reports negative headroom on an over-quota origin', async () => {
    stubNavigator({ gpu: adapterYielding({}), deviceMemory: 8, storage: estimating(9e9, 8e9) })

    await expect(detectCapability()).resolves.toMatchObject({ freeBytes: 0 })
  })

  it('still reports free space on the unsupported path, where the panel shows it', async () => {
    stubNavigator({ deviceMemory: 8, storage: estimating(0, 5e9) })

    await expect(detectCapability()).resolves.toMatchObject({ webgpu: false, freeBytes: 5e9 })
  })
})

// A visitor with 1.5 GB free being asked to wait for a 1.8 GB download is the
// worst first run this app can produce: twenty minutes, then a failure. The
// verdict is what lets the landing page say so before the button is pressed.
describe('fitsInFreeSpace', () => {
  const MODEL = 1_816_930_956

  it('says too-small when the weights alone will not fit', () => {
    expect(fitsInFreeSpace(MODEL, 1_500_000_000)).toBe('too-small')
  })

  it('says tight when the weights fit but the overhead will not', () => {
    expect(fitsInFreeSpace(MODEL, MODEL + 1)).toBe('tight')
    expect(fitsInFreeSpace(MODEL, MODEL + SPACE_HEADROOM_BYTES - 1)).toBe('tight')
  })

  it('says fits once there is room for the weights and the working overhead', () => {
    expect(fitsInFreeSpace(MODEL, MODEL + SPACE_HEADROOM_BYTES)).toBe('fits')
    expect(fitsInFreeSpace(MODEL, 50_000_000_000)).toBe('fits')
  })

  // Guessing on the browser's behalf is how someone waits out a download that
  // was never going to fit.
  it('says unknown rather than guessing when the browser will not estimate', () => {
    expect(fitsInFreeSpace(MODEL, null)).toBe('unknown')
    expect(fitsInFreeSpace(MODEL, Number.NaN)).toBe('unknown')
  })

  it('treats a completely full origin as too-small', () => {
    expect(fitsInFreeSpace(MODEL, 0)).toBe('too-small')
  })
})
