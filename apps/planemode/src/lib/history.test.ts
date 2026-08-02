import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DB_NAME,
  WEBLLM_CACHE_NAMES,
  type Conversation,
  closeDb,
  exportAll,
  listConversations,
  saveConversation,
  storageUsage,
  wipeAll,
  wipeModelWeights,
} from './history'

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'First flight',
    messages: [
      { role: 'user', content: 'Does this work with the network off?' },
      { role: 'assistant', content: 'Yes — nothing here leaves the device.' },
    ],
    updatedAt: 1_754_000_000_000,
    ...overrides,
  }
}

/** A CacheStorage stand-in. WebLLM keeps weights in Cache Storage, so wipeAll
 *  has to reach into it; Node has no `caches`, so we supply one. */
function stubCaches(initial: string[]) {
  const names = new Set(initial)
  const api = {
    keys: vi.fn(async () => [...names]),
    delete: vi.fn(async (name: string) => names.delete(name)),
    has: vi.fn(async (name: string) => names.has(name)),
  }
  vi.stubGlobal('caches', api)
  return { api, names }
}

async function existingDatabaseNames(): Promise<string[]> {
  const dbs = await indexedDB.databases()
  return dbs.map((d) => d.name).filter((n): n is string => typeof n === 'string')
}

/** Creates a database the way WebLLM's IndexedDB cache backend would. */
function createDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('urls')
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

beforeEach(async () => {
  await closeDb()
  for (const name of await existingDatabaseNames()) {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = resolve
      request.onerror = resolve
      request.onblocked = resolve
    })
  }
})

afterEach(async () => {
  await closeDb()
  vi.unstubAllGlobals()
})

describe('conversation round-trip', () => {
  it('saves and reads a conversation back intact', async () => {
    const c = conversation()
    await saveConversation(c)

    const all = await listConversations()

    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(c)
  })

  it('overwrites on the same id rather than duplicating', async () => {
    await saveConversation(conversation())
    await saveConversation(conversation({ title: 'Renamed', updatedAt: 1_754_000_009_999 }))

    const all = await listConversations()

    expect(all).toHaveLength(1)
    expect(all[0]!.title).toBe('Renamed')
  })

  it('returns the most recently updated conversation first', async () => {
    await saveConversation(conversation({ id: 'old', updatedAt: 1 }))
    await saveConversation(conversation({ id: 'new', updatedAt: 2 }))

    await expect(listConversations()).resolves.toMatchObject([{ id: 'new' }, { id: 'old' }])
  })

  it('returns an empty list on a fresh origin', async () => {
    await expect(listConversations()).resolves.toEqual([])
  })
})

describe('exportAll', () => {
  it('produces parseable JSON containing the saved conversation', async () => {
    const c = conversation()
    await saveConversation(c)

    const blob = await exportAll()
    const parsed = JSON.parse(await blob.text())

    expect(blob.type).toContain('application/json')
    expect(parsed.app).toBe('planemode')
    expect(parsed.conversations).toEqual([c])
  })

  it('exports an empty but still valid document when there is nothing saved', async () => {
    const parsed = JSON.parse(await (await exportAll()).text())
    expect(parsed.conversations).toEqual([])
    expect(typeof parsed.exportedAt).toBe('string')
  })
})

describe('wipeAll', () => {
  it('leaves listConversations empty', async () => {
    stubCaches([])
    await saveConversation(conversation())

    await wipeAll()

    await expect(listConversations()).resolves.toEqual([])
  })

  // The part that is easy to forget. Conversations are kilobytes; the weights
  // are gigabytes. A wipe that only clears IndexedDB conversations would report
  // success while leaving 2 GB on disk, which breaks the storage-honesty promise.
  it('deletes the WebLLM Cache Storage buckets, not just the conversations', async () => {
    const { api, names } = stubCaches([...WEBLLM_CACHE_NAMES, 'unrelated-app-cache'])
    await saveConversation(conversation())

    await wipeAll()

    for (const name of WEBLLM_CACHE_NAMES) {
      expect(api.delete).toHaveBeenCalledWith(name)
      expect(names.has(name)).toBe(false)
    }
  })

  it('leaves caches belonging to the sibling apps alone', async () => {
    const { api, names } = stubCaches([...WEBLLM_CACHE_NAMES, 'recto-shell', 'workbox-precache-v2'])

    await wipeAll()

    expect(names.has('recto-shell')).toBe(true)
    expect(names.has('workbox-precache-v2')).toBe(true)
    expect(api.delete).not.toHaveBeenCalledWith('recto-shell')
  })

  it('deletes the WebLLM IndexedDB cache databases too', async () => {
    stubCaches([])
    for (const name of WEBLLM_CACHE_NAMES) await createDatabase(name)
    await createDatabase('some-other-app-db')
    await saveConversation(conversation())

    await wipeAll()

    const remaining = await existingDatabaseNames()
    for (const name of WEBLLM_CACHE_NAMES) expect(remaining).not.toContain(name)
    expect(remaining).toContain('some-other-app-db')
  })

  it('works on an origin where Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined)
    await saveConversation(conversation())

    await expect(wipeAll()).resolves.toBeUndefined()
    await expect(listConversations()).resolves.toEqual([])
  })

  it('is idempotent', async () => {
    stubCaches([...WEBLLM_CACHE_NAMES])
    await saveConversation(conversation())

    await wipeAll()
    await expect(wipeAll()).resolves.toBeUndefined()
    await expect(listConversations()).resolves.toEqual([])
  })
})

describe('wipeModelWeights', () => {
  it('removes the weights but keeps the conversations', async () => {
    const { names } = stubCaches([...WEBLLM_CACHE_NAMES])
    await saveConversation(conversation())

    await wipeModelWeights()

    for (const name of WEBLLM_CACHE_NAMES) expect(names.has(name)).toBe(false)
    await expect(listConversations()).resolves.toHaveLength(1)
  })
})

describe('storageUsage', () => {
  it('passes through what the browser estimates', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 1_816_930_956, quota: 20_000_000_000 }) },
    })

    await expect(storageUsage()).resolves.toEqual({
      usageBytes: 1_816_930_956,
      quotaBytes: 20_000_000_000,
    })
  })

  it('reports zeroes rather than throwing when the API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(storageUsage()).resolves.toEqual({ usageBytes: 0, quotaBytes: 0 })
  })
})

describe('database identity', () => {
  it('uses a app-specific database name so sibling apps on this origin are untouched', () => {
    expect(DB_NAME).toBe('planemode')
    expect(WEBLLM_CACHE_NAMES).toEqual(['webllm/model', 'webllm/wasm', 'webllm/config'])
  })
})
