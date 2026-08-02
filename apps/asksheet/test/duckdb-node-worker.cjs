/**
 * Runs duckdb-wasm's Node worker bundle inside a `node:worker_threads` Worker.
 *
 * That bundle is written against the Web Worker API — it assigns
 * `globalThis.onmessage` and calls `globalThis.postMessage` — neither of which
 * exists in a plain Node worker. The published recipe installs the `web-worker`
 * package to supply them. These fifteen lines supply the same three globals and
 * are the whole reason AskSheet has no test-only runtime dependency.
 *
 * Test support only. Nothing in `src/` imports this, and it never ships.
 */
const { parentPort, workerData } = require('node:worker_threads')

globalThis.self = globalThis
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer)
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.close = () => process.exit(0)

// Registered before the bundle loads, and resolved lazily, because the bundle
// assigns `onmessage` as its very last statement.
parentPort.on('message', (data) => {
  if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data })
})

require(workerData.script)
