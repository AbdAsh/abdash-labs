import { useCallback, useEffect, useState } from 'react'
import { exportAll, storageUsage, wipeAll, wipeModelWeights } from '../lib/history'
import { formatBytes, type ModelTier } from '../lib/tiers'

/**
 * Storage honesty, made visible.
 *
 * The figure shown is whatever `navigator.storage.estimate()` reports for this
 * origin — not a number the app made up from the model's advertised size. The
 * wipe button has to actually return the origin to near-zero, which is why it
 * clears WebLLM's caches as well as the conversation store, and why deleting
 * the weights tells the app so: a panel still listing a model that is no longer
 * on disk is exactly the kind of stale claim this section exists to rule out.
 */
export function StoragePanel({
  tier,
  disabled,
  onModelDeleted,
}: {
  tier: ModelTier | null
  /** Set while a reply is streaming. Erasing the weights out from under a
   *  running generation strands it, and would write the half-finished reply
   *  back into a store the visitor just asked to be emptied. */
  disabled?: boolean
  /** Lets the app drop the engine and go back to the first-run screen. */
  onModelDeleted: (alsoWipedConversations: boolean) => void
}) {
  const [usage, setUsage] = useState<{ usageBytes: number; quotaBytes: number } | null>(null)
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const busy = working || Boolean(disabled)

  const refresh = useCallback(async () => {
    setUsage(await storageUsage())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const download = async () => {
    setProblem(null)
    try {
      const blob = await exportAll()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `planemode-export-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      // Revoking in the same tick races the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) {
      setProblem(
        `Could not build the export: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const run = async (
    action: () => Promise<void>,
    confirmation: string,
    wipedConversations: boolean,
  ) => {
    if (!window.confirm(confirmation)) return
    setWorking(true)
    setProblem(null)
    try {
      await action()
      onModelDeleted(wipedConversations)
    } catch (error) {
      // A wipe that half-worked must say so rather than show a fresh zero.
      setProblem(
        `The erase did not finish: ${error instanceof Error ? error.message : String(error)}. ` +
          'Some data may still be on this device.',
      )
    } finally {
      await refresh()
      setWorking(false)
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

      {problem && <p className="app__error">{problem}</p>}

      {disabled && !working && (
        <p className="storage__note">Available once the current reply has finished.</p>
      )}

      <div className="storage__actions">
        <button type="button" onClick={download} disabled={busy}>
          Export conversations as JSON
        </button>

        <button
          type="button"
          disabled={busy || !tier}
          onClick={() =>
            void run(
              wipeModelWeights,
              'Delete the downloaded model? Your conversations are kept. You will need to download the weights again to chat.',
              false,
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
            void run(
              wipeAll,
              'Erase everything — conversations and the downloaded model? This cannot be undone.',
              true,
            )
          }
        >
          Erase everything
        </button>
      </div>
    </section>
  )
}
