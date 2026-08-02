import { useCallback, useEffect, useState } from 'react'
import { exportAll, storageUsage, wipeAll, wipeModelWeights } from '../lib/history'
import { formatBytes, type ModelTier } from '../lib/tiers'

/**
 * Storage honesty, made visible.
 *
 * The figure shown is whatever `navigator.storage.estimate()` reports for this
 * origin — not a number the app made up from the model's advertised size. The
 * wipe button has to actually return the origin to near-zero, which is why it
 * clears WebLLM's caches as well as the conversation store.
 */
export function StoragePanel({ tier }: { tier: ModelTier | null }) {
  const [usage, setUsage] = useState<{ usageBytes: number; quotaBytes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setUsage(await storageUsage())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const download = async () => {
    const blob = await exportAll()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `planemode-export-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const run = async (action: () => Promise<void>, confirmation: string) => {
    if (!window.confirm(confirmation)) return
    setBusy(true)
    try {
      await action()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="storage">
      <h2>Storage on this device</h2>

      <dl className="storage__figures">
        <div>
          <dt>Used by this origin</dt>
          <dd>{usage ? formatBytes(usage.usageBytes) : '—'}</dd>
        </div>
        <div>
          <dt>Browser allowance</dt>
          <dd>{usage ? formatBytes(usage.quotaBytes) : '—'}</dd>
        </div>
        <div>
          <dt>Model held</dt>
          <dd>{tier ? `${tier.label} — about ${formatBytes(tier.approxBytes)}` : 'None'}</dd>
        </div>
      </dl>

      <p className="storage__note">
        Measured with <code>navigator.storage.estimate()</code>, so it is the browser's number
        rather than ours.
      </p>

      <div className="storage__actions">
        <button type="button" onClick={download} disabled={busy}>
          Export conversations as JSON
        </button>

        <button
          type="button"
          disabled={busy || !tier}
          onClick={() =>
            run(
              wipeModelWeights,
              'Delete the downloaded model? Your conversations are kept. You will need to download the weights again to chat.',
            )
          }
        >
          Delete the model, keep conversations
        </button>

        <button
          type="button"
          className="storage__danger"
          disabled={busy}
          onClick={() =>
            run(
              wipeAll,
              'Erase everything — conversations and the downloaded model? This cannot be undone.',
            )
          }
        >
          Erase everything
        </button>
      </div>
    </section>
  )
}
