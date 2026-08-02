import { useCallback, useEffect, useState } from 'react'
import { cacheSize, clearCache } from '../lib/cache'

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

/**
 * Browser storage readout and reset.
 *
 * The cache is the reason a re-run costs nothing, and also the reason this app
 * can quietly put tens of megabytes in someone's browser. A tool that writes that
 * much owes the user a number and a button — especially since the browser gives
 * no obvious way to find or reclaim it.
 */
export function CacheControls() {
  const [state, setState] = useState<{ entries: number; approxBytes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setState(await cacheSize())
    } catch {
      setState(null)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const clear = async () => {
    setBusy(true)
    try {
      await clearCache()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cache-controls">
      <span className="dim">
        {state
          ? `Embedding cache: ${state.entries} entr${state.entries === 1 ? 'y' : 'ies'}, ${mb(state.approxBytes)} in this browser`
          : 'Embedding cache unavailable in this browser'}
      </span>
      <button
        type="button"
        className="secondary"
        onClick={clear}
        disabled={busy || !state || state.entries === 0}
      >
        {busy ? 'Clearing…' : 'Clear cache'}
      </button>
    </div>
  )
}
