/// <reference lib="webworker" />
import {
  CreateMLCEngine,
  hasModelInCache,
  type MLCEngineInterface,
  type InitProgressReport,
} from '@mlc-ai/web-llm'
import {
  describeEngineError,
  isFatal,
  parseLoadProgress,
  type ChatMessage,
  type EngineEvent,
  type WorkerCommand,
} from '../lib/engine-protocol'

/**
 * The WebLLM engine, kept off the UI thread.
 *
 * Weights are fetched by WebLLM from the HuggingFace CDN using its default
 * `prebuiltAppConfig`. That default is deliberately left alone — see
 * ../lib/tiers.ts for why self-hosting is neither possible nor desirable.
 */

let engine: MLCEngineInterface | null = null
let loadedModelId: string | null = null
let abort: AbortController | null = null
let loading = false

function post(event: EngineEvent): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(event)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Answers "is this model already on disk?" without loading anything.
 *
 * This is what turns a return visit from "Download 0.70 GB and start" — which
 * would be a lie — into a straight load from cache. A model whose cache is only
 * partly written answers false, which is correct: it still needs the network.
 */
async function probe(modelIds: string[]): Promise<void> {
  const cached: string[] = []
  for (const modelId of modelIds) {
    try {
      if (await hasModelInCache(modelId)) cached.push(modelId)
    } catch {
      // A missing or half-written cache manifest throws. Absent, then.
    }
  }
  post({ type: 'cached', modelIds: cached })
}

async function load(modelId: string): Promise<void> {
  if (loadedModelId === modelId && engine) {
    post({ type: 'ready' })
    return
  }
  if (loading) {
    post({ type: 'error', message: 'A model is already loading.' })
    return
  }

  loading = true
  try {
    // A half-initialised engine from a previous failed attempt holds GPU memory
    // the new one needs, so it goes first.
    if (engine) {
      await engine.unload().catch(() => undefined)
      engine = null
      loadedModelId = null
    }

    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report: InitProgressReport) => {
        // WebLLM restarts its 0..1 fraction for each stage of the load, so the
        // sentence is parsed into a named stage rather than driving one bar.
        post({ type: 'progress', progress: parseLoadProgress(report.text, report.progress) })
      },
    })
    loadedModelId = modelId
    post({ type: 'ready' })
  } catch (error) {
    engine = null
    loadedModelId = null
    post({ type: 'error', message: messageOf(error) })
  } finally {
    loading = false
  }
}

/**
 * Drops the oldest turns when the conversation outgrows the context window.
 *
 * Failing, or silently forgetting, are both worse than saying so — the caller
 * gets a `trimmed` event to render a visible notice. The estimate is
 * deliberately crude (roughly four characters per token) and deliberately
 * conservative: it reserves room for the reply.
 */
const CHARS_PER_TOKEN = 4

function trimToContext(
  messages: ChatMessage[],
  contextWindow: number,
  reserveForReply = 512,
): { kept: ChatMessage[]; dropped: number } {
  const budgetChars = Math.max(0, contextWindow - reserveForReply) * CHARS_PER_TOKEN
  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  let used = system.reduce((n, m) => n + m.content.length, 0)
  const kept: ChatMessage[] = []
  // Walk backwards so the most recent turns survive.
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const message = rest[i]!
    if (used + message.content.length > budgetChars && kept.length > 0) break
    used += message.content.length
    kept.unshift(message)
  }
  return { kept: [...system, ...kept], dropped: rest.length - kept.length }
}

async function generate(
  messages: ChatMessage[],
  contextWindow: number,
  maxTokens?: number,
): Promise<void> {
  if (!engine) {
    post({ type: 'error', message: 'No model is loaded yet.' })
    return
  }

  const { kept, dropped } = trimToContext(messages, contextWindow)
  if (dropped > 0) post({ type: 'trimmed', dropped })

  abort = new AbortController()
  const signal = abort.signal

  try {
    const stream = await engine.chat.completions.create({
      messages: kept as never,
      stream: true,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    })

    for await (const chunk of stream) {
      if (signal.aborted) break
      const text = chunk.choices[0]?.delta?.content
      if (text) post({ type: 'token', text })
    }

    if (signal.aborted) await engine.interruptGenerate()
    post({ type: 'done' })
  } catch (error) {
    const message = messageOf(error)
    // A lost device or an out-of-memory kill leaves the engine unusable, and
    // pretending otherwise means every later message fails the same way. Drop it
    // so the next attempt is a genuine reload rather than a replay of the crash.
    if (isFatal(describeEngineError(message).kind)) {
      engine = null
      loadedModelId = null
    }
    post({ type: 'error', message })
  } finally {
    abort = null
  }
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data
  switch (command.type) {
    case 'probe':
      void probe(command.modelIds)
      break
    case 'load':
      void load(command.modelId)
      break
    case 'generate':
      void generate(command.messages, command.contextWindow, command.maxTokens)
      break
    case 'stop':
      abort?.abort()
      void engine?.interruptGenerate()
      break
    case 'unload':
      void engine?.unload()
      engine = null
      loadedModelId = null
      break
  }
}

export {}
