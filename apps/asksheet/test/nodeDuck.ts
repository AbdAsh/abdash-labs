import * as duckdb from '@duckdb/duckdb-wasm'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker as NodeWorker } from 'node:worker_threads'

/**
 * A real DuckDB, running under Node.
 *
 * `initDuck()` in `src/lib/duck.ts` fetches the single-threaded bundle from
 * jsDelivr and wraps its worker in a blob shim; neither works outside a browser.
 * This builds the equivalent Node-flavoured database so that everything below
 * that bootstrap — CSV registration, type inference, the timeout, the row cap,
 * `buildProfile` — can be exercised for real. Hand it to `attachDuck()`.
 *
 * Two callers, and they are the reason this is not inlined in the test:
 *   - `src/lib/duck.test.ts`, the integration suite;
 *   - `scripts/capture-example.mjs`, which profiles the bundled sample with the
 *     same engine the browser uses before sending that profile to the live
 *     planner. A fixture captured against a hand-written profile would prove
 *     nothing, so the profile has to come from a genuine load.
 *
 * Test and tooling support only. Nothing in `src/` imports this, and it never
 * ships.
 */

/** Supplies the Web Worker globals inside the worker. See the file for why. */
const WORKER_BOOTSTRAP = fileURLToPath(new URL('./duckdb-node-worker.cjs', import.meta.url))

/**
 * The main-thread half of the Web Worker API, over `node:worker_threads`.
 *
 * `AsyncDuckDB` drives its worker through `addEventListener`, `postMessage` and
 * `terminate`. Together with the bootstrap above this replaces the `web-worker`
 * package the published Node recipe reaches for — a dependency whose only job in
 * this repo would be these thirty lines.
 */
type Listener = (event: unknown) => void

class NodeWorkerShim {
  private readonly worker: NodeWorker
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(scriptPath: string) {
    this.worker = new NodeWorker(WORKER_BOOTSTRAP, { workerData: { script: scriptPath } })
    this.worker.on('message', (data: unknown) => this.emit('message', { data }))
    this.worker.on('error', (error: Error) => this.emit('error', { message: error.message, error }))
    this.worker.on('exit', () => this.emit('close', {}))
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: unknown, transfer?: readonly unknown[]): void {
    this.worker.postMessage(message, transfer as never)
  }

  terminate(): void {
    void this.worker.terminate()
  }
}

export async function bootNodeDuck(): Promise<duckdb.AsyncDuckDB> {
  const require = createRequire(import.meta.url)
  const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm'))
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: path.resolve(dist, './duckdb-mvp.wasm'),
      mainWorker: path.resolve(dist, './duckdb-node-mvp.worker.cjs'),
    },
    eh: {
      mainModule: path.resolve(dist, './duckdb-eh.wasm'),
      mainWorker: path.resolve(dist, './duckdb-node-eh.worker.cjs'),
    },
  })
  const db = new duckdb.AsyncDuckDB(
    new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR),
    new NodeWorkerShim(bundle.mainWorker!) as never,
  )
  await db.instantiate(bundle.mainModule)
  return db
}
