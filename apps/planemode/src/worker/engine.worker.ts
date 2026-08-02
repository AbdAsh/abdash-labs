/// <reference lib="webworker" />
import { CreateMLCEngine, type MLCEngineInterface, type InitProgressReport } from '@mlc-ai/web-llm'
import type { ChatMessage, EngineEvent, WorkerCommand } from '../lib/engine-protocol'

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

function post(event: EngineEvent): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(event)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(modelId: string): Promise<void> {
  if (loadedModelId === modelId && engine) {
    post({ type: 'ready' })
    return
  }

  try {
    engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (report: InitProgressReport) => {
        // WebLLM reports progress as a 0..1 fraction plus a human sentence.
        // Both are forwarded: the fraction drives the bar, the sentence
        // explains which of the several phases is running.
        post({
          type: 'download',
          loaded: Math.max(0, Math.min(1, report.progress)),
          total: 1,
          text: report.text,
        })
      },
    })
    loadedModelId = modelId
    post({ type: 'ready' })
  } catch (error) {
    engine = null
    loadedModelId = null
    post({ type: 'error', message: messageOf(error) })
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

async function generate(messages: ChatMessage[], contextWindow: number): Promise<void> {
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
    })

    for await (const chunk of stream) {
      if (signal.aborted) break
      const text = chunk.choices[0]?.delta?.content
      if (text) post({ type: 'token', text })
    }

    if (signal.aborted) await engine.interruptGenerate()
    post({ type: 'done' })
  } catch (error) {
    post({ type: 'error', message: messageOf(error) })
  } finally {
    abort = null
  }
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data
  switch (command.type) {
    case 'load':
      void load(command.modelId)
      break
    case 'generate':
      void generate(command.messages, command.contextWindow)
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
