/**
 * Honest hardware detection.
 *
 * The product promise is "download it once and it works". Every judgement call
 * here therefore leans conservative: when the browser will not tell us
 * something, we recommend the smaller model. A download that fails after two
 * gigabytes is a much worse experience than a model that is a little smaller.
 */

export interface Capability {
  webgpu: boolean
  approxMemoryGB: number | null
  recommended: 'small' | 'mid' | null
  reason?: string
}

/** `navigator.deviceMemory` is capped at 8 by the spec, so 8 is "the most this
 *  API will ever admit to" — the right bar for the larger model. */
export const MID_TIER_MIN_MEMORY_GB = 8

/** The mid tier needs roughly 3 GB of VRAM. An adapter that cannot hand out a
 *  1 GiB buffer will not hold it, whatever the system RAM says. */
export const MID_TIER_MIN_BUFFER_BYTES = 1024 * 1024 * 1024

interface AdapterLike {
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number }
}

interface NavigatorLike {
  gpu?: { requestAdapter: () => Promise<AdapterLike | null> }
  deviceMemory?: unknown
}

function currentNavigator(): NavigatorLike | undefined {
  return (globalThis as { navigator?: NavigatorLike }).navigator
}

/** Returns the reported memory in GB, or null when the browser will not say.
 *  Anything that is not a positive finite number counts as "will not say". */
function readApproxMemoryGB(nav: NavigatorLike | undefined): number | null {
  const raw = nav?.deviceMemory
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  return raw
}

/** Only downgrades when the adapter actually reports a limit. A stubbed or
 *  limit-less adapter is not evidence of a small GPU, so it is left alone. */
function adapterCanHoldMidTier(adapter: AdapterLike): boolean {
  const limits = adapter.limits
  if (!limits) return true
  const candidates = [limits.maxBufferSize, limits.maxStorageBufferBindingSize].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0,
  )
  if (candidates.length === 0) return true
  return Math.max(...candidates) >= MID_TIER_MIN_BUFFER_BYTES
}

export async function detectCapability(): Promise<Capability> {
  const nav = currentNavigator()
  const approxMemoryGB = readApproxMemoryGB(nav)

  if (!nav?.gpu) {
    return {
      webgpu: false,
      approxMemoryGB,
      recommended: null,
      reason:
        'This browser does not support WebGPU, so a model cannot run on this device. ' +
        'PlaneMode needs Chrome or Edge 113 or newer on desktop, or a recent Chromium ' +
        'browser on Android. Safari and Firefox are still rolling WebGPU out.',
    }
  }

  let adapter: AdapterLike | null
  try {
    adapter = await nav.gpu.requestAdapter()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      webgpu: false,
      approxMemoryGB,
      recommended: null,
      reason:
        `This browser has WebGPU, but opening a GPU adapter failed (${detail}). ` +
        'That usually means hardware acceleration is switched off, or the GPU driver ' +
        'is blocklisted. Re-enabling hardware acceleration normally fixes it.',
    }
  }

  if (!adapter) {
    return {
      webgpu: false,
      approxMemoryGB,
      recommended: null,
      reason:
        'This browser has WebGPU, but it offered no GPU adapter. That normally means ' +
        'hardware acceleration is disabled, or the machine has no GPU the browser is ' +
        'willing to use.',
    }
  }

  if (approxMemoryGB === null) {
    return {
      webgpu: true,
      approxMemoryGB: null,
      recommended: 'small',
      reason:
        'This browser does not report how much memory the device has, so PlaneMode is ' +
        'recommending the smaller model rather than guessing high. A download that ' +
        'fails after two gigabytes is worse than a smaller model that just works. ' +
        'You can switch tiers by hand.',
    }
  }

  if (approxMemoryGB >= MID_TIER_MIN_MEMORY_GB) {
    if (!adapterCanHoldMidTier(adapter)) {
      return {
        webgpu: true,
        approxMemoryGB,
        recommended: 'small',
        reason:
          `This device reports about ${approxMemoryGB} GB of memory, but the GPU will ` +
          'not allocate a buffer large enough for the bigger model. The smaller model ' +
          'is the safe choice here.',
      }
    }
    return {
      webgpu: true,
      approxMemoryGB,
      recommended: 'mid',
      reason:
        `This device reports about ${approxMemoryGB} GB of memory, which is enough for ` +
        'the larger model. The smaller one is still available if you would rather not ' +
        'spend the disk space.',
    }
  }

  return {
    webgpu: true,
    approxMemoryGB,
    recommended: 'small',
    reason:
      `This device reports about ${approxMemoryGB} GB of memory, so PlaneMode recommends ` +
      `the smaller model. The larger one wants ${MID_TIER_MIN_MEMORY_GB} GB or more.`,
  }
}
