import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EngineEvent, WorkerCommand } from './engine-protocol'
import { generate, loadModel, probeCache, stop, unload, warmUp } from './engine'
import { offlineTracker } from './offline'
import type { ModelTier } from './tiers'

/**
 * `engine.ts` is where this app's mutable state lives — one worker, one
 * listener slot, one in-flight flag — and every bug in it is a bug that only
 * shows up on the *second* thing you do. These tests drive it through those
 * second things.
 */

class MockWorker {
  static last: MockWorker | null = null

  onmessage: ((event: { data: EngineEvent }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly posted: WorkerCommand[] = []
  terminated = false

  constructor() {
    MockWorker.last = this
  }

  postMessage(command: WorkerCommand): void {
    this.posted.push(command)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(event: EngineEvent): void {
    this.onmessage?.({ data: event })
  }
}

/** Lets the awaits inside engine.ts (persistent storage, promise plumbing) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function worker(): Promise<MockWorker> {
  await flush()
  if (!MockWorker.last) throw new Error('no worker was created')
  return MockWorker.last
}

const TIER: ModelTier = {
  id: 'small',
  modelId: 'test-model-MLC',
  label: 'Test',
  approxBytes: 1000,
  vramRequiredMB: 100,
  // Deliberately not 4096, so the fallback is distinguishable from a real tier.
  contextWindow: 8192,
  weightsUrl: 'https://huggingface.co/test',
  blurb: '',
}

beforeEach(() => {
  MockWorker.last = null
  vi.stubGlobal('Worker', MockWorker)
})

afterEach(() => {
  unload()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('probeCache', () => {
  it('reports which models the worker found on disk', async () => {
    const pending = probeCache(['a', 'b'])
    ;(await worker()).emit({ type: 'cached', modelIds: ['a'] })

    await expect(pending).resolves.toEqual(['a'])
  })

  it('reports nothing cached rather than failing when the probe errors', async () => {
    const pending = probeCache(['a'])
    ;(await worker()).emit({ type: 'error', message: 'cache unreadable' })

    await expect(pending).resolves.toEqual([])
  })
})

describe('loadModel', () => {
  it('forwards progress and resolves once the worker is ready', async () => {
    const seen: string[] = []
    const pending = loadModel(TIER, (p) => seen.push(p.stage))
    const w = await worker()

    w.emit({
      type: 'progress',
      progress: { stage: 'downloading', fraction: 0.5, bytes: 500, text: 'half' },
    })
    w.emit({ type: 'ready' })

    await expect(pending).resolves.toEqual({ ok: true })
    expect(seen).toEqual(['downloading'])
  })

  it('resolves with the failure rather than rejecting', async () => {
    const pending = loadModel(TIER, () => undefined)
    ;(await worker()).emit({ type: 'error', message: 'Failed to fetch' })

    await expect(pending).resolves.toEqual({ ok: false, message: 'Failed to fetch' })
  })

  // A tier left behind by a load that failed would have a later generation
  // sending the context window of a model that is not resident.
  it('stops claiming a tier once its load has failed', async () => {
    const failed = loadModel(TIER, () => undefined)
    const w = await worker()
    w.emit({ type: 'error', message: 'nope' })
    await failed

    void generate([{ role: 'user', content: 'hi' }], () => undefined)
    await flush()

    const command = w.posted.find((c) => c.type === 'generate')
    expect(command).toMatchObject({ contextWindow: 4096 })
    expect(command).not.toMatchObject({ contextWindow: TIER.contextWindow })
  })
})

describe('generate', () => {
  async function ready(): Promise<MockWorker> {
    const pending = loadModel(TIER, () => undefined)
    const w = await worker()
    w.emit({ type: 'ready' })
    await pending
    return w
  }

  it('streams tokens and resolves on done', async () => {
    const w = await ready()
    let text = ''

    const pending = generate([{ role: 'user', content: 'hi' }], (event) => {
      if (event.type === 'token') text += event.text
    })
    await flush()
    w.emit({ type: 'token', text: 'he' })
    w.emit({ type: 'token', text: 'llo' })
    w.emit({ type: 'done' })

    await expect(pending).resolves.toEqual({ ok: true })
    expect(text).toBe('hello')
  })

  it('uses the loaded tier’s context window', async () => {
    const w = await ready()

    void generate([{ role: 'user', content: 'hi' }], () => undefined)
    await flush()

    expect(w.posted.at(-1)).toMatchObject({ contextWindow: TIER.contextWindow })
  })

  // The worker keeps one abort controller, so two overlapping streams corrupt
  // each other. The UI is meant to prevent it; this is the part that does not
  // depend on the UI being right.
  it('refuses a second generation while one is in flight', async () => {
    const w = await ready()

    const first = generate([{ role: 'user', content: 'one' }], () => undefined)
    await flush()
    const second = await generate([{ role: 'user', content: 'two' }], () => undefined)

    expect(second.ok).toBe(false)
    expect(second.message).toMatch(/already/i)

    w.emit({ type: 'done' })
    await first
  })

  // The in-flight guard is exactly the kind of flag that gets stuck and poisons
  // every later attempt, so both exits from it are pinned down.
  it('accepts the next generation after one completes', async () => {
    const w = await ready()

    const first = generate([{ role: 'user', content: 'one' }], () => undefined)
    await flush()
    w.emit({ type: 'done' })
    await first

    const second = generate([{ role: 'user', content: 'two' }], () => undefined)
    await flush()
    w.emit({ type: 'done' })

    await expect(second).resolves.toEqual({ ok: true })
  })

  it('accepts the next generation after one fails', async () => {
    const w = await ready()

    const first = generate([{ role: 'user', content: 'one' }], () => undefined)
    await flush()
    w.emit({ type: 'error', message: 'boom' })
    await first

    const second = generate([{ role: 'user', content: 'two' }], () => undefined)
    await flush()
    w.emit({ type: 'done' })

    await expect(second).resolves.toEqual({ ok: true })
  })

  it('passes a stop straight through to the worker', async () => {
    const w = await ready()

    stop()

    expect(w.posted.at(-1)).toEqual({ type: 'stop' })
  })
})

describe('worker failure', () => {
  // A worker that never boots — a chunk missing on a cold offline start — used
  // to leave the load promise pending and the UI frozen on "Starting…".
  it('turns a worker that will not start into a settled failure', async () => {
    const pending = loadModel(TIER, () => undefined)
    const w = await worker()

    w.onerror?.({ message: 'Failed to load worker script' })

    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(w.terminated).toBe(true)
  })

  it('settles a generation when the worker sends something unreadable', async () => {
    const load = loadModel(TIER, () => undefined)
    const w = await worker()
    w.emit({ type: 'ready' })
    await load

    const pending = generate([{ role: 'user', content: 'hi' }], () => undefined)
    await flush()
    w.onmessageerror?.()

    await expect(pending).resolves.toMatchObject({ ok: false })
  })
})

describe('unload', () => {
  // Wiping the weights from the storage panel while a reply is streaming used
  // to tear the worker out from under the generation, leaving its promise
  // pending: the composer stayed locked behind a Stop button with nothing left
  // to stop, and only a page reload got it back.
  it('settles a generation that is still in flight', async () => {
    const load = loadModel(TIER, () => undefined)
    const w = await worker()
    w.emit({ type: 'ready' })
    await load

    const pending = generate([{ role: 'user', content: 'hi' }], () => undefined)
    await flush()

    unload()

    await expect(pending).resolves.toMatchObject({ ok: false })
  })

  it('leaves the next load free to start a fresh worker', async () => {
    const load = loadModel(TIER, () => undefined)
    const first = await worker()
    first.emit({ type: 'ready' })
    await load

    unload()
    MockWorker.last = null

    void loadModel(TIER, () => undefined)
    const second = await worker()

    expect(second).not.toBe(first)
    expect(first.terminated).toBe(true)
  })
})

describe('what may earn the offline badge', () => {
  async function ready(): Promise<MockWorker> {
    const pending = loadModel(TIER, () => undefined)
    const w = await worker()
    w.emit({ type: 'ready' })
    await pending
    return w
  }

  it('announces a real generation to the offline tracker', async () => {
    const started = vi.spyOn(offlineTracker, 'recordGenerationStarted')
    const token = vi.spyOn(offlineTracker, 'recordToken')
    const complete = vi.spyOn(offlineTracker, 'recordGenerationComplete')
    const w = await ready()

    const pending = generate([{ role: 'user', content: 'hi' }], () => undefined)
    await flush()
    w.emit({ type: 'token', text: 'ok' })
    w.emit({ type: 'done' })
    await pending

    expect(started).toHaveBeenCalledTimes(1)
    expect(token).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  // The warm-up runs automatically on every load. Letting it verify would mean
  // an offline reload lit the badge before the visitor typed anything — true,
  // but indistinguishable from a badge that is simply hard-coded.
  it('hides the warm-up from the tracker entirely', async () => {
    const started = vi.spyOn(offlineTracker, 'recordGenerationStarted')
    const token = vi.spyOn(offlineTracker, 'recordToken')
    const complete = vi.spyOn(offlineTracker, 'recordGenerationComplete')
    const w = await ready()

    const pending = warmUp()
    await flush()
    w.emit({ type: 'token', text: 'OK' })
    w.emit({ type: 'done' })
    await pending

    expect(started).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('caps the warm-up so it does not generate a whole reply', async () => {
    const w = await ready()

    void warmUp()
    await flush()

    expect(w.posted.at(-1)).toMatchObject({ type: 'generate', maxTokens: 1 })
  })

  it('tells the tracker when a generation fails, so nothing stays pending', async () => {
    const failed = vi.spyOn(offlineTracker, 'recordGenerationFailed')
    const w = await ready()

    const pending = generate([{ role: 'user', content: 'hi' }], () => undefined)
    await flush()
    w.emit({ type: 'error', message: 'boom' })
    await pending

    expect(failed).toHaveBeenCalledTimes(1)
  })
})
