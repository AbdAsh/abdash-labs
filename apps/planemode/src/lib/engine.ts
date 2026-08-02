import type { ChatMessage, EngineEvent, WorkerCommand } from './engine-protocol'
import { requestPersistentStorage } from './persist'
import { offlineTracker } from './offline'
import { TIERS, DEFAULT_TIER_ID, tierById, formatBytes, type ModelTier } from './tiers'

export type { ChatMessage, EngineEvent } from './engine-protocol'
export type { ModelTier, TierId } from './tiers'
export { TIERS, DEFAULT_TIER_ID, tierById, formatBytes }

/**
 * Main-thread proxy for the engine worker.
 *
 * Nothing here imports `@mlc-ai/web-llm`; the library only ever loads inside
 * the worker, so the UI bundle stays small and the UI thread never blocks on
 * model compilation.
 */

let worker: Worker | null = null
let listener: ((event: EngineEvent) => void) | null = null
let activeTier: ModelTier | null = null

function ensureWorker(): Worker {
  worker ??= new Worker(new URL('../worker/engine.worker.ts', import.meta.url), {
    type: 'module',
    name: 'planemode-engine',
  })
  worker.onmessage = (event: MessageEvent<EngineEvent>) => listener?.(event.data)
  return worker
}

function send(command: WorkerCommand): void {
  ensureWorker().postMessage(command)
}

export function currentTier(): ModelTier | null {
  return activeTier
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
  onEvent: (event: EngineEvent) => void,
): Promise<void> {
  await requestPersistentStorage()

  activeTier = tier
  return new Promise<void>((resolve) => {
    listener = (event) => {
      onEvent(event)
      if (event.type === 'ready' || event.type === 'error') {
        listener = null
        resolve()
      }
    }
    send({ type: 'load', modelId: tier.modelId })
  })
}

export async function generate(
  messages: ChatMessage[],
  onEvent: (event: EngineEvent) => void,
): Promise<void> {
  offlineTracker.recordGenerationStarted()

  return new Promise<void>((resolve) => {
    listener = (event) => {
      onEvent(event)
      if (event.type === 'done') {
        // The badge's whole claim rests on this call: a generation that
        // *completed*, not merely a navigator.onLine reading.
        offlineTracker.recordGenerationComplete()
        listener = null
        resolve()
      } else if (event.type === 'error') {
        offlineTracker.recordGenerationFailed()
        listener = null
        resolve()
      }
    }
    send({
      type: 'generate',
      messages,
      contextWindow: activeTier?.contextWindow ?? 4096,
    })
  })
}

export function stop(): void {
  worker?.postMessage({ type: 'stop' } satisfies WorkerCommand)
}

/** A throwaway generation so the first real message does not pay compile cost. */
export async function warmUp(): Promise<void> {
  await generate([{ role: 'user', content: 'Say OK.' }], () => undefined)
}

export function unload(): void {
  worker?.postMessage({ type: 'unload' } satisfies WorkerCommand)
  worker?.terminate()
  worker = null
  activeTier = null
}
