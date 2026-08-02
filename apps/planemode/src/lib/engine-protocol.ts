/**
 * The message contract between the UI thread and the engine worker.
 *
 * Kept in its own module, free of any `@mlc-ai/web-llm` import, so the UI side
 * and the tests can use these types without pulling a multi-megabyte library
 * into the main bundle.
 */

export interface ChatMessage {
  role: string
  content: string
}

export type EngineEvent =
  /** `loaded`/`total` are a 0..1 fraction; `text` is WebLLM's own phase sentence. */
  | { type: 'download'; loaded: number; total: number; text: string }
  | { type: 'ready' }
  | { type: 'token'; text: string }
  | { type: 'done' }
  /** Oldest turns fell out of the context window. Render a visible notice. */
  | { type: 'trimmed'; dropped: number }
  | { type: 'error'; message: string }

export type WorkerCommand =
  | { type: 'load'; modelId: string }
  | { type: 'generate'; messages: ChatMessage[]; contextWindow: number }
  | { type: 'stop' }
  | { type: 'unload' }
