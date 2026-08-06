import type { LoadProgress, LoadStage } from '../lib/engine-protocol'
import { formatBytes, type ModelTier } from '../lib/tiers'

/**
 * Real numbers, and the right noun for what is happening.
 *
 * WebLLM runs three stages back to back and restarts its 0..1 fraction for each
 * one, so a single bar wired to that fraction fills up three times and reads as
 * a broken app. Worse, the middle stage — reading the weights off this device's
 * own disk and into GPU memory — looks exactly like downloading if you only
 * watch the number. Calling that a download would tell a returning visitor they
 * are paying for the model a second time, which is the one lie this app cannot
 * afford. So the stages are named, and only the first one is called a download.
 */

const STAGES: { id: LoadStage; label: string }[] = [
  { id: 'downloading', label: 'Download' },
  { id: 'loading', label: 'Into GPU memory' },
  { id: 'compiling', label: 'Compile shaders' },
]

function stageIndex(stage: LoadStage): number {
  if (stage === 'preparing') return 0
  if (stage === 'finished') return STAGES.length
  return STAGES.findIndex((s) => s.id === stage)
}

export function DownloadProgress({
  tier,
  progress,
  fromCache,
}: {
  tier: ModelTier
  progress: LoadProgress
  /** True when the weights were already on disk, so nothing is being fetched. */
  fromCache: boolean
}) {
  const percent = Math.round(progress.fraction * 100)
  const current = stageIndex(progress.stage)
  const downloading = progress.stage === 'downloading'

  const heading = downloading
    ? `Downloading ${tier.label}`
    : fromCache
      ? `Opening ${tier.label}`
      : `Preparing ${tier.label}`

  return (
    <section className="download" aria-live="polite">
      <h2>{heading}</h2>

      {fromCache && !downloading && (
        <p className="download__cached">
          Already on this device — nothing is being downloaded. This works with the network off.
        </p>
      )}

      <ol className="download__stages">
        {STAGES.map((stage, index) => {
          // The download stage is skipped outright on a cached start, so it is
          // marked done rather than pending — it genuinely is.
          const skipped = fromCache && stage.id === 'downloading'
          const state = skipped || index < current ? 'done' : index === current ? 'now' : 'next'
          return (
            <li key={stage.id} className={`download__stage is-${state}`}>
              {stage.label}
            </li>
          )
        })}
      </ol>

      <div
        className="download__bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${STAGES[current]?.label ?? 'Preparing'}: ${percent}%`}
      >
        <div className="download__fill" style={{ width: `${percent}%` }} />
      </div>

      <p className="download__numbers">
        <strong>{percent}%</strong>
        {downloading && (
          <>
            {' '}
            — {formatBytes(progress.bytes ?? 0)} of about {formatBytes(tier.approxBytes)} fetched
          </>
        )}
        {progress.stage === 'loading' && progress.bytes !== null && (
          <> — {formatBytes(progress.bytes)} read from this device</>
        )}
      </p>

      {/* WebLLM's own sentence, verbatim. It is more specific than anything
          this component could paraphrase, and it names the shard being worked
          on, which is what makes a long wait feel like progress. */}
      <p className="download__phase">{progress.text}</p>

      {downloading ? (
        <p className="download__note">
          Safe to close this tab. Every piece is cached as it arrives, so reopening resumes from
          here rather than starting over. The files come straight from the HuggingFace CDN.
        </p>
      ) : (
        <p className="download__note">
          No network needed from here on. This stage reads what is already on your disk and hands it
          to the GPU.
        </p>
      )}
    </section>
  )
}
