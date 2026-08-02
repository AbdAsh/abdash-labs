/**
 * Persistent-storage request.
 *
 * Without this the browser treats the cached weights as best-effort data and
 * may evict them under storage pressure. The user would then open the app on a
 * plane and find a two-gigabyte download waiting — the entire premise, silently
 * broken. It has to be asked for *before* the download starts.
 *
 * `StorageManager.persist()` is `[Exposed=Window]`: it does not exist on
 * `WorkerNavigator`, so this must run on the main thread, not inside the engine
 * worker.
 */

export type PersistResult = 'persisted' | 'denied' | 'unsupported'

export async function requestPersistentStorage(): Promise<PersistResult> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
  if (typeof storage?.persist !== 'function') return 'unsupported'
  try {
    // Already-granted origins short-circuit without re-prompting.
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'persisted'
    return (await storage.persist()) ? 'persisted' : 'denied'
  } catch {
    return 'unsupported'
  }
}
