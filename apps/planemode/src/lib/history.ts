import { openDB, type IDBPDatabase } from 'idb'

/**
 * Local history, export and wipe.
 *
 * Everything PlaneMode remembers lives on the device. That is only credible if
 * the storage numbers are honest and the wipe button genuinely empties the
 * origin, weights included — see `wipeAll`.
 */

export interface Conversation {
  id: string
  title: string
  messages: { role: string; content: string }[]
  updatedAt: number
}

export const DB_NAME = 'planemode'
export const DB_VERSION = 1
export const STORE_CONVERSATIONS = 'conversations'

/**
 * Where WebLLM keeps model weights, compiled wasm and model config.
 *
 * Verified against `@mlc-ai/web-llm@0.2.84`: the library creates artifact
 * caches under exactly these three scope names, and uses the same strings as
 * IndexedDB database names when `useIndexedDBCache` is on. Both backends are
 * cleared below, because which one is in play depends on the browser.
 */
export const WEBLLM_CACHE_NAMES = ['webllm/model', 'webllm/wasm', 'webllm/config'] as const

let dbPromise: Promise<IDBPDatabase> | null = null

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        const store = database.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
    },
  })
  return dbPromise
}

/** Releases the connection. Exported for tests and for wipe-then-reopen flows. */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return
  const open = dbPromise
  dbPromise = null
  try {
    ;(await open).close()
  } catch {
    // Already closed or never opened cleanly; nothing to release.
  }
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await (await db()).put(STORE_CONVERSATIONS, conversation)
}

/** Newest first, which is the order the sidebar wants. */
export async function listConversations(): Promise<Conversation[]> {
  const all = (await (await db()).getAll(STORE_CONVERSATIONS)) as Conversation[]
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteConversation(id: string): Promise<void> {
  await (await db()).delete(STORE_CONVERSATIONS, id)
}

export async function exportAll(): Promise<Blob> {
  const payload = {
    app: 'planemode',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    conversations: await listConversations(),
  }
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
}

export async function storageUsage(): Promise<{ usageBytes: number; quotaBytes: number }> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
  if (typeof storage?.estimate !== 'function') return { usageBytes: 0, quotaBytes: 0 }
  try {
    const { usage, quota } = await storage.estimate()
    return { usageBytes: usage ?? 0, quotaBytes: quota ?? 0 }
  } catch {
    return { usageBytes: 0, quotaBytes: 0 }
  }
}

function deleteDatabase(name: string): Promise<void> {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (!factory) return Promise.resolve()
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // A blocked delete means another tab holds the database. Resolving keeps
    // the wipe from hanging; the delete completes when that tab closes.
    request.onblocked = () => resolve()
  })
}

/**
 * Deletes the cached model weights, and only those.
 *
 * Named cache-by-cache rather than "delete everything", because six sibling
 * apps share this origin's Cache Storage and a broad sweep would blow away
 * their offline shells.
 */
export async function wipeModelWeights(): Promise<void> {
  const cacheStorage = (globalThis as { caches?: CacheStorage }).caches
  if (cacheStorage) {
    await Promise.all(
      WEBLLM_CACHE_NAMES.map((name) => Promise.resolve(cacheStorage.delete(name)).catch(() => false)),
    )
  }
  await Promise.all(WEBLLM_CACHE_NAMES.map(deleteDatabase))
}

/**
 * Empties the origin: conversations *and* cached weights.
 *
 * The weights are the whole storage story — conversations are kilobytes, the
 * model is gigabytes. A wipe that skipped them would report success while
 * leaving two gigabytes on disk.
 */
export async function wipeAll(): Promise<void> {
  const database = await db()
  await database.clear(STORE_CONVERSATIONS)
  await wipeModelWeights()
}
