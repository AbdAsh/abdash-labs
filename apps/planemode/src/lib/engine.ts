import type { ChatMessage, EngineEvent, LoadProgress, WorkerCommand } from './engine-protocol'
import { requestPersistentStorage } from './persist'
import { offlineTracker } from './offline'
import type { ModelTier } from './tiers'

/**
 * Main-thread proxy for the engine worker.
 *
 * Nothing here imports `@mlc-ai/web-llm`; the library only ever loads inside
 * the worker, so the UI bundle stays small and the UI thread never blocks on
 * model compilation.
 */

/** Every call below resolves rather than rejects — a failed download is a state
 *  the UI has to render, not an exception it has to catch. */
export interface EngineOutcome {
  ok: boolean
  message?: string
}

let worker: Worker | null = null
let listener: ((event: EngineEvent) => void) | null = null
let activeTier: ModelTier | null = null
let inFlight = false

function ensureWorker(): Worker {
  if (worker) return worker

  const created = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), {
    type: 'module',
    name: 'planemode-engine',
  })
  created.onmessage = (event: MessageEvent<EngineEvent>) => listener?.(event.data)

  // A worker that never boots — a chunk missing on a cold offline start, a
  // stale cached build that no longer parses — would otherwise leave every
  // promise below pending forever, and the UI frozen on "Starting…". Turning
  // that into an error event is the difference between a message and a hang.
  const fail = (message: string) => {
    if (worker === created) worker = null
    created.terminate()
    inFlight = false
    listener?.({ type: 'error', message })
  }
  created.onerror = (event) =>
    fail(event.message || 'The engine worker could not start. Reloading the page usually fixes it.')
  created.onmessageerror = () => fail('The engine worker sent a message this browser could not read.')

  worker = created
  return created
}

function send(command: WorkerCommand): void {
  ensureWorker().postMessage(command)
}

/** Which of these models are already fully on disk. Loads no weights. */
export function probeCache(modelIds: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    listener = (event) => {
      if (event.type === 'cached') {
        listener = null
        resolve(event.modelIds)
      } else if (event.type === 'error') {
        listener = null
        resolve([])
      }
    }
    send({ type: 'probe', modelIds })
  })
}

/**
 * Downloads (or reattaches to) a model and reports progress.
 *
 * Persistent storage is requested first, before a single byte is fetched.
 * Without it the browser may evict multi-gigabyte weights under pressure, and
 * the next offline launch finds nothing cached.
 */
export async function loadModel(
  tier: ModelTier,
  onProgress: (progress: LoadProgress) => void,
): Promise<EngineOutcome> {
  await requestPersistentStorage()

  activeTier = tier
  return new Promise<EngineOutcome>((resolve) => {
    listener = (event) => {
      if (event.type === 'progress') {
        onProgress(event.progress)
      } else if (event.type === 'ready') {
        listener = null
        resolve({ ok: true })
      } else if (event.type === 'error') {
        listener = null
        // Nothing is loaded, so nothing may claim to be: a stale activeTier
        // would let a later generate() send a context window for a model that
        // is not there.
        activeTier = null
        resolve({ ok: false, message: event.message })
      }
    }
    send({ type: 'load', modelId: tier.modelId })
  })
}

/**
 * @param track whether this generation may earn the offline badge. Only
 *   generations a person asked for count; see `warmUp`.
 */
function run(
  messages: ChatMessage[],
  onEvent: (event: EngineEvent) => void,
  track: boolean,
  maxTokens?: number,
): Promise<EngineOutcome> {
  // The worker keeps one abort controller and WebLLM keeps one lock per model,
  // so two overlapping requests corrupt each other's stream. The UI is supposed
  // to prevent this; this is the guarantee that does not depend on the UI.
  if (inFlight) {
    return Promise.resolve({ ok: false, message: 'A reply is already being generated.' })
  }
  inFlight = true
  if (track) offlineTracker.recordGenerationStarted()

  return new Promise<EngineOutcome>((resolve) => {
    const settle = (outcome: EngineOutcome) => {
      inFlight = false
      listener = null
      resolve(outcome)
    }

    listener = (event) => {
      if (event.type === 'token') {
        if (track) offlineTracker.recordToken()
        onEvent(event)
      } else if (event.type === 'trimmed') {
        onEvent(event)
      } else if (event.type === 'done') {
        // The badge's whole claim rests on this call: a generation that
        // *completed*, not merely a navigator.onLine reading.
        if (track) offlineTracker.recordGenerationComplete()
        settle({ ok: true })
      } else if (event.type === 'error') {
        if (track) offlineTracker.recordGenerationFailed()
        settle({ ok: false, message: event.message })
      }
    }

    send({
      type: 'generate',
      messages,
      contextWindow: activeTier?.contextWindow ?? 4096,
      ...(maxTokens ? { maxTokens } : {}),
    })
  })
}

export function generate(
  messages: ChatMessage[],
  onEvent: (event: EngineEvent) => void,
): Promise<EngineOutcome> {
  return run(messages, onEvent, true)
}

export function stop(): void {
  worker?.postMessage({ type: 'stop' } satisfies WorkerCommand)
}

/**
 * A throwaway generation so the first real message does not pay compile cost.
 *
 * Deliberately does **not** count toward the offline badge. It runs
 * automatically on every load, so letting it verify would mean an offline
 * reload lit the badge before the visitor had typed anything — true, but
 * indistinguishable from a badge that is simply hard-coded. The claim is worth
 * more when a person watches themselves earn it.
 */
export function warmUp(): Promise<EngineOutcome> {
  return run([{ role: 'user', content: 'Say OK.' }], () => undefined, false, 1)
}

export function unload(): void {
  // Anything still waiting on the worker has to be told before the worker is
  // torn out from under it. Without this, unloading during a generation leaves
  // that promise pending forever: the caller keeps believing a reply is on its
  // way, the composer stays locked behind a Stop button with nothing to stop,
  // and the only way out is a reload.
  listener?.({ type: 'error', message: 'The model was unloaded.' })

  worker?.postMessage({ type: 'unload' } satisfies WorkerCommand)
  worker?.terminate()
  worker = null
  listener = null
  activeTier = null
  inFlight = false
}
