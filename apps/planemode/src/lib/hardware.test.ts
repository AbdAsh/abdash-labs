import { describe, it, expect, vi, afterEach } from 'vitest'
import { detectCapability, MID_TIER_MIN_MEMORY_GB, MID_TIER_MIN_BUFFER_BYTES } from './hardware'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A minimal stand-in for a GPUAdapter. Real adapters carry a `limits` bag; a
 *  bare stub deliberately does not, so the memory path can be tested alone. */
function stubNavigator(options: {
  gpu?: unknown
  deviceMemory?: unknown
} = {}) {
  const nav: Record<string, unknown> = {}
  if ('gpu' in options) nav.gpu = options.gpu
  if ('deviceMemory' in options) nav.deviceMemory = options.deviceMemory
  vi.stubGlobal('navigator', nav)
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
