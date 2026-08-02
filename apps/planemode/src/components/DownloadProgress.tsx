import { formatBytes, type ModelTier } from '../lib/tiers'

/**
 * Real numbers, not a spinner.
 *
 * A visitor watching a two-gigabyte download needs to see it moving and needs
 * to know it will not start again from zero. WebLLM caches every shard as it
 * arrives, so a reload resumes where it stopped — which is worth saying out
 * loud, because nobody assumes it.
 */
export function DownloadProgress({
  tier,
  fraction,
  phase,
}: {
  tier: ModelTier
  /** 0..1, as reported by WebLLM's init progress callback. */
  fraction: number
  phase: string
}) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
  const doneBytes = Math.round(tier.approxBytes * Math.max(0, Math.min(1, fraction)))

  return (
    <section className="download" aria-live="polite">
      <h2>Downloading {tier.label}</h2>

      <div
        className="download__bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="download__fill" style={{ width: `${percent}%` }} />
      </div>

      <p className="download__numbers">
        <strong>{percent}%</strong> — {formatBytes(doneBytes)} of {formatBytes(tier.approxBytes)}
      </p>

      <p className="download__phase">{phase}</p>

      <p className="download__note">
        Safe to close this tab. Every piece is cached as it arrives, so reopening resumes from here
        rather than starting over. The files come straight from the HuggingFace CDN.
      </p>
    </section>
  )
}
