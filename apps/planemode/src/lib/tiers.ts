/**
 * Pinned model builds.
 *
 * Resolved against `prebuiltAppConfig.model_list` from **@mlc-ai/web-llm 0.2.84**
 * (the exact version pinned in package.json, without a caret — `model_lib` URLs
 * embed the package version as `v0_2_84/base/…`, so a minor bump would change
 * the wasm URLs and invalidate every already-downloaded copy).
 *
 * Both tiers are `q4f32_1` rather than `q4f16_1`. The f16 builds are smaller
 * and faster but require the WebGPU `shader-f16` feature, and an app whose
 * whole promise is "it just works after one download" should not gate itself on
 * an optional GPU feature. The f16 builds remain a future opt-in.
 *
 * Weights stream from the HuggingFace CDN into WebLLM's own cache. They are
 * never self-hosted: Cloudflare Pages caps files at 25 MiB, and serving 1.8 GB
 * of weights fifty times would be 90 GB of transfer for no benefit.
 */

export type TierId = 'small' | 'mid'

export interface ModelTier {
  id: TierId
  modelId: string
  label: string
  /** Bytes actually downloaded, measured from the HuggingFace repo file sizes. */
  approxBytes: number
  /** WebLLM's own `vram_required_MB` for this build. */
  vramRequiredMB: number
  contextWindow: number
  /** The HuggingFace repo the weights stream from. */
  weightsUrl: string
  blurb: string
}

export const TIERS: ModelTier[] = [
  {
    id: 'small',
    modelId: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    label: 'Small — Llama 3.2 1B Instruct (q4f32)',
    approxBytes: 704_588_843,
    vramRequiredMB: 1128.82,
    contextWindow: 4096,
    weightsUrl: 'https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC',
    blurb: 'The safe default. Downloads fastest, runs on modest laptops and phones.',
  },
  {
    id: 'mid',
    modelId: 'Llama-3.2-3B-Instruct-q4f32_1-MLC',
    label: 'Mid — Llama 3.2 3B Instruct (q4f32)',
    approxBytes: 1_816_930_956,
    vramRequiredMB: 2951.51,
    contextWindow: 4096,
    weightsUrl: 'https://huggingface.co/mlc-ai/Llama-3.2-3B-Instruct-q4f32_1-MLC',
    blurb: 'Noticeably better answers. Wants 8 GB of memory and a capable GPU.',
  },
]

export const DEFAULT_TIER_ID: TierId = 'small'

export function tierById(id: TierId): ModelTier {
  const tier = TIERS.find((t) => t.id === id)
  if (!tier) throw new Error(`Unknown model tier: ${id}`)
  return tier
}

/** Human-readable download size, for stating the deal before it is accepted. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${Math.round(bytes / 1000)} kB`
}
