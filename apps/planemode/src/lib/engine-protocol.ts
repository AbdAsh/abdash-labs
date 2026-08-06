/**
 * The message contract between the UI thread and the engine worker, plus the
 * pure functions for making sense of what comes back.
 *
 * Deliberately free of any `@mlc-ai/web-llm` import. The library is tens of
 * megabytes and must only ever load inside the worker, so the contract — and
 * the two parsers below, which are the parts most worth testing — live in a
 * module that `lib/engine.ts`, the components and the tests can all import
 * without dragging web-llm into the main bundle.
 */

export interface ChatMessage {
  role: string
  content: string
}

/**
 * Loading a model runs through several stages, and WebLLM reports a *fresh*
 * 0..1 fraction for each one: the fetch climbs to 100%, resets, the load into
 * GPU memory climbs to 100%, resets, and shader compilation climbs to 100%
 * again. A single bar wired straight to `report.progress` therefore fills up
 * three times, which reads as a bug. Naming the stages is what makes the
 * progress honest.
 */
export type LoadStage = 'preparing' | 'downloading' | 'loading' | 'compiling' | 'finished'

export interface LoadProgress {
  stage: LoadStage
  /** 0..1 *within the current stage*, not across the whole load. */
  fraction: number
  /** Bytes WebLLM says it has moved in this stage; null when it does not say. */
  bytes: number | null
  /** WebLLM's own sentence, verbatim. The last word on what is happening. */
  text: string
}

export const INITIAL_PROGRESS: LoadProgress = {
  stage: 'preparing',
  fraction: 0,
  bytes: null,
  text: 'Starting…',
}

/** WebLLM counts in whole mebibytes: `Math.ceil(bytes / (1024 * 1024))`. */
const MIB = 1024 * 1024

const FETCHING = /^Fetching param cache\[\d+\/\d+\]:\s*(\d+)MB fetched/
const LOADING = /^Loading model from cache\[\d+\/\d+\]:\s*(\d+)MB loaded/
const COMPILING = /^Loading GPU shader modules\[/
const FINISHED = /^Finish loading on/

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * Turns one `InitProgressReport` into a stage plus an honest byte count.
 *
 * The distinction that matters is `downloading` versus `loading`: the first is
 * bytes coming off the network, the second is bytes coming off this device's
 * own disk. Reporting the second as a download would tell a returning visitor
 * they are re-downloading a model they already own, which is the one lie this
 * app cannot afford.
 */
export function parseLoadProgress(text: string, progress: number): LoadProgress {
  const fraction = clamp01(progress)
  const trimmed = text?.trim() ?? ''

  const fetching = FETCHING.exec(trimmed)
  if (fetching) {
    return { stage: 'downloading', fraction, bytes: Number(fetching[1]) * MIB, text: trimmed }
  }

  const loading = LOADING.exec(trimmed)
  if (loading) {
    return { stage: 'loading', fraction, bytes: Number(loading[1]) * MIB, text: trimmed }
  }

  if (COMPILING.test(trimmed)) {
    return { stage: 'compiling', fraction, bytes: null, text: trimmed }
  }

  if (FINISHED.test(trimmed)) {
    return { stage: 'finished', fraction: 1, bytes: null, text: trimmed }
  }

  return { stage: 'preparing', fraction, bytes: null, text: trimmed || INITIAL_PROGRESS.text }
}

export type EngineFailureKind = 'memory' | 'gpu' | 'storage' | 'network' | 'context' | 'unknown'

export interface EngineFailure {
  kind: EngineFailureKind
  /** A sentence a visitor can act on, not a stack trace. */
  message: string
}

/** True when the engine cannot be trusted to answer again without a reload. */
export function isFatal(kind: EngineFailureKind): boolean {
  return kind === 'gpu' || kind === 'memory'
}

/**
 * Translates whatever WebGPU, WebLLM or `fetch` threw into something a person
 * can act on.
 *
 * Every branch here corresponds to a failure that really happens: the GPU
 * device dropping under memory pressure, a download dying at 90% because the
 * train went into a tunnel, a disk with no room left, a conversation that
 * outgrew the context window. An unrecognised error keeps its original text
 * rather than being flattened into "something went wrong".
 */
export function describeEngineError(raw: string): EngineFailure {
  const text = (raw || '').trim()

  // "DeviceLostError", "Device was lost", "GPUDevice lost: destroyed" — the same
  // failure arrives worded three different ways depending on who threw it.
  if (/device\s*(\w+\s+)?lost|devicelost|gpu.*(crash|disconnect)|adapter.*lost/i.test(text)) {
    return {
      kind: 'gpu',
      message:
        'The browser dropped the GPU device, which usually means it ran out of video memory. ' +
        'Close your other tabs and reload the model. If it happens again, choose the smaller tier.',
    }
  }

  if (/out of memory|oom|allocat\w* (failed|too large)|buffer size|exceeds the limit/i.test(text)) {
    return {
      kind: 'memory',
      message:
        'This device could not find enough memory for the model. Choose the smaller tier, or ' +
        'close your other tabs and try again.',
    }
  }

  if (/quota|storage.*full|no space|exceeded the storage/i.test(text)) {
    return {
      kind: 'storage',
      message:
        'This browser ran out of storage part-way through. Free some disk space, or delete the ' +
        'model from the storage panel and choose the smaller tier.',
    }
  }

  if (/failed to fetch|networkerror|network error|load failed|err_internet|offline/i.test(text)) {
    return {
      kind: 'network',
      message:
        'The download could not reach the model files. Nothing already fetched is lost — ' +
        'reconnect and try again, and it picks up where it stopped rather than starting over.',
    }
  }

  if (/context ?window|contextwindowsize|prompt.*too long|exceeds.*context/i.test(text)) {
    return {
      kind: 'context',
      message:
        'That conversation is longer than the model can hold at once. Start a fresh conversation ' +
        'and the model will keep up.',
    }
  }

  // An unrecognised failure keeps its original words — that string is the only
  // clue anyone has when a new failure mode appears in the wild — but it still
  // ends with something to do. A sentence that names a cause and stops there
  // leaves the visitor staring at a dead app.
  const RECOVERY =
    'Try reloading the model; if it keeps happening, the smaller tier is the safer choice.'
  return {
    kind: 'unknown',
    message: text
      ? `The model engine reported: ${text}. ${RECOVERY}`
      : `The model engine failed and gave no reason. ${RECOVERY}`,
  }
}

export type EngineEvent =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'ready' }
  | { type: 'token'; text: string }
  | { type: 'done' }
  /** Oldest turns fell out of the context window. Render a visible notice. */
  | { type: 'trimmed'; dropped: number }
  /** Answer to `probe`: the subset of the asked-for models already on disk. */
  | { type: 'cached'; modelIds: string[] }
  | { type: 'error'; message: string }

export type WorkerCommand =
  | { type: 'probe'; modelIds: string[] }
  | { type: 'load'; modelId: string }
  | { type: 'generate'; messages: ChatMessage[]; contextWindow: number; maxTokens?: number }
  | { type: 'stop' }
  | { type: 'unload' }
