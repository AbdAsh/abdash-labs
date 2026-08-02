import type { ChunkerId, ChunkerParams } from './chunkers'

/**
 * The embedding cache. In the browser, and only in the browser.
 *
 * This module exists because of one number. A twelve-config run over a
 * hundred-page document produces roughly 3,600 embeddings; at 1536 dimensions
 * that is about 11 MB, so forty-five such runs would consume the entire 500 MB
 * Postgres database shared by all seven lab apps. Vectors therefore live in
 * IndexedDB and are never sent to the server. Postgres stores configuration,
 * question sets, gold spans and computed metrics — nothing that scales with
 * document size.
 *
 * The cost is that two visitors benchmarking the same document each pay to embed
 * it. At $0.02 per million tokens that is a rounding error, and determinism is
 * unaffected because identical inputs produce identical vectors.
 *
 * Implemented directly on the IndexedDB API rather than through `idb`: the store
 * is a single flat key/value map, the wrapper would save about thirty lines, and
 * dropping the dependency keeps `cacheKey` — the part that can silently corrupt a
 * benchmark — unit-testable without any install step.
 */

const DB_NAME = 'raglab-cache'
const DB_VERSION = 1
const STORE = 'vectors'

/** Bump when the record shape changes; old keys then simply miss. */
const KEY_VERSION = 1

interface CacheRecord {
  key: string
  /** Flat float32 buffer: `count * dim` values, row-major. */
  data: Float32Array
  count: number
  dim: number
  bytes: number
  createdAt: number
}

/**
 * Escapes a field so no value can impersonate a delimiter.
 *
 * Without this, `cacheKey('x|y', …, 'm')` and `cacheKey('x', …, 'y|m')` produce
 * the same string, and one config silently reads another's vectors — a benchmark
 * that looks completely normal and is completely wrong.
 */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/**
 * The identity of one embedded chunking: same key means byte-identical vectors.
 *
 * Injective by construction rather than hashed — no digest, so no birthday
 * problem, and the key stays readable in the devtools storage inspector when a
 * result looks wrong.
 */
export function cacheKey(
  fingerprint: string,
  chunker: ChunkerId,
  p: ChunkerParams,
  model: string,
): string {
  return [
    `raglab:v${KEY_VERSION}`,
    esc(fingerprint),
    esc(chunker),
    `size=${p.size}`,
    `overlap=${p.overlap}`,
    esc(model),
  ].join('|')
}

/**
 * Rounds vectors to float32, the precision the cache stores.
 *
 * Applied on the *fresh* path too, not just on read. A cache miss would otherwise
 * score with float64 values and a cache hit with float32 ones, so the same config
 * could rank two near-tied chunks differently on a re-run and break the
 * determinism guarantee — the one property that makes these benchmarks citable.
 */
export function quantize(vectors: number[][]): number[][] {
  return vectors.map((v) => Array.from(Float32Array.from(v)))
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, mode)
    const result = await fn(tx.objectStore(STORE))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    })
    return result
  } finally {
    db.close()
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export async function getCached(key: string): Promise<number[][] | null> {
  const record = await withStore('readonly', (s) =>
    request<CacheRecord | undefined>(s.get(key) as IDBRequest<CacheRecord | undefined>))
  if (!record) return null

  const { data, count, dim } = record
  const out: number[][] = Array.from({ length: count })
  for (let i = 0; i < count; i++) {
    out[i] = Array.from(data.subarray(i * dim, (i + 1) * dim))
  }
  return out
}

export async function putCached(key: string, vectors: number[][]): Promise<void> {
  const count = vectors.length
  const dim = count === 0 ? 0 : vectors[0]!.length
  if (vectors.some((v) => v.length !== dim)) {
    throw new Error('putCached: all vectors in a set must have the same dimension')
  }

  // One flat Float32Array rather than an array of arrays: half the bytes of
  // float64 and a single structured-clone allocation instead of thousands.
  const data = new Float32Array(count * dim)
  for (let i = 0; i < count; i++) data.set(vectors[i]!, i * dim)

  const record: CacheRecord = {
    key,
    data,
    count,
    dim,
    bytes: data.byteLength,
    createdAt: Date.now(),
  }
  await withStore('readwrite', (s) => request(s.put(record)))
}

/** Entry count and payload bytes, for the storage readout in the UI. */
export async function cacheSize(): Promise<{ entries: number; approxBytes: number }> {
  return withStore('readonly', (store) =>
    new Promise<{ entries: number; approxBytes: number }>((resolve, reject) => {
      let entries = 0
      let approxBytes = 0
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return resolve({ entries, approxBytes })
        entries++
        approxBytes += (cursor.value as CacheRecord).bytes ?? 0
        cursor.continue()
      }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'))
    }))
}

/**
 * Drops every cached vector set.
 *
 * Surfaced in the UI on purpose: these entries are tens of megabytes and the
 * browser gives no obvious way to reclaim them, so a tool that writes them owes
 * the user a button that removes them.
 */
export async function clearCache(): Promise<void> {
  await withStore('readwrite', (s) => request(s.clear()))
}
