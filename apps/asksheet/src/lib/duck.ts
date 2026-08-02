import * as duckdb from '@duckdb/duckdb-wasm'
import { assertSupportedType } from './columnTypes'
import { quoteIdent } from './profile'
import type { ColumnInfo, QueryResult } from './types'

/**
 * DuckDB-WASM in a worker. This module is the only thing in the app that touches
 * the engine, and the engine is the only thing that ever sees a row.
 */

export const DEFAULT_TIMEOUT_MS = 10_000

/** Rows kept for display. A pathological cross join must not freeze the tab. */
export const MAX_RESULT_ROWS = 5_000

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The query took longer than ${Math.round(timeoutMs / 1000)}s and was cancelled.`)
    this.name = 'QueryTimeoutError'
  }
}

let db: duckdb.AsyncDuckDB | null = null
let booting: Promise<void> | null = null

/**
 * Selects the single-threaded bundle deliberately.
 *
 * `selectBundle` only picks the COI (multi-threaded) build when the page is
 * cross-origin isolated, which needs COOP/COEP headers on this path. We start
 * without that constraint — it would be a header rule shared with six sibling
 * apps — and only add it if profiling shows the 50k-row target is missed.
 *
 * The worker is loaded through a blob shim rather than straight from the CDN
 * URL: a classic worker script must be same-origin, and `bundle.mainWorker`
 * points at jsDelivr.
 */
export async function initDuck(): Promise<void> {
  if (db) return
  if (booting) return booting

  booting = (async () => {
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
    const shim = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
    )
    try {
      const worker = new Worker(shim)
      const instance = new duckdb.AsyncDuckDB(
        new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
        worker,
      )
      await instance.instantiate(bundle.mainModule, bundle.pthreadWorker)
      db = instance
    } finally {
      URL.revokeObjectURL(shim)
    }
  })()

  try {
    await booting
  } finally {
    booting = null
  }
}

/** Tears the database down. Used between tests and when the user loads a new file. */
export async function resetDuck(): Promise<void> {
  if (!db) return
  const instance = db
  db = null
  await instance.terminate()
}

function requireDb(): duckdb.AsyncDuckDB {
  if (!db) throw new Error('DuckDB is not running yet. Call initDuck() first.')
  return db
}

/**
 * Arrow hands back BigInt for 64-bit integers and typed proxies for nested
 * values. Neither survives `JSON.stringify` or a React render, so everything is
 * flattened here rather than at each display site.
 */
function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown
    } catch {
      return String(value)
    }
  }
  return value
}

/** True for statements a `select * from (...) limit N` wrapper can safely enclose. */
function isWrappable(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(sql)
}

export async function registerCsv(
  file: File | string,
  tableName = 'data',
): Promise<ColumnInfo[]> {
  await initDuck()
  const instance = requireDb()
  const virtualPath = `${tableName}.csv`
  const ident = quoteIdent(tableName)

  // A second upload must not read the first file's bytes.
  try {
    await instance.dropFile(virtualPath)
  } catch {
    /* nothing registered under that name yet */
  }

  if (typeof file === 'string') {
    await instance.registerFileText(virtualPath, file)
  } else {
    await instance.registerFileBuffer(virtualPath, new Uint8Array(await file.arrayBuffer()))
  }

  const conn = await instance.connect()
  try {
    // SAMPLE_SIZE=-1 scans the whole file for type inference. A 50k-row CSV whose
    // last thousand rows switch a column to text is exactly the case that makes
    // sampled inference produce a confusing wrong answer.
    await conn.query(
      `create or replace table ${ident} as
       select * from read_csv_auto('${virtualPath}', SAMPLE_SIZE=-1, ALL_VARCHAR=false)`,
    )
    const described = await conn.query(`describe ${ident}`)
    return described.toArray().map((row) => {
      const record = row as unknown as Record<string, unknown>
      return { name: String(record.column_name), type: String(record.column_type) }
    })
  } finally {
    await conn.close()
  }
}

/**
 * Runs one statement with a wall-clock timeout and a display row cap.
 *
 * `Promise.race` alone would leave the worker grinding after the UI gave up, so
 * the pending query is cancelled and the connection closed on timeout.
 */
export async function runQuery(
  sql: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRows = MAX_RESULT_ROWS,
): Promise<QueryResult> {
  await initDuck()
  const instance = requireDb()
  const conn = await instance.connect()

  const capped = isWrappable(sql) && maxRows > 0 ? `select * from (\n${sql}\n) limit ${maxRows + 1}` : sql

  let timer: ReturnType<typeof setTimeout> | undefined
  const started = performance.now()

  try {
    const table = await Promise.race([
      conn.query(capped),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // `cancelSent` reaches into the worker; without it `Promise.race` would
          // resolve the UI while DuckDB kept churning on a dead query.
          void conn.cancelSent().catch(() => undefined)
          reject(new QueryTimeoutError(timeoutMs))
        }, timeoutMs)
      }),
    ])

    const columns: ColumnInfo[] = table.schema.fields.map((field) => ({
      name: field.name,
      type: String(field.type),
    }))
    const all = table.toArray().map((row) => {
      const record = row as unknown as Record<string, unknown>
      return columns.map((column) => normalize(record[column.name]))
    })
    const truncated = maxRows > 0 && all.length > maxRows

    return {
      columns,
      rows: truncated ? all.slice(0, maxRows) : all,
      elapsedMs: Math.round(performance.now() - started),
      truncated,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    await conn.close().catch(() => undefined)
  }
}

/**
 * Re-types one column in place.
 *
 * `try_cast` rather than `cast`: a single unparseable cell should become NULL,
 * not abort the whole correction and leave the user stuck with a wrong type.
 * The rebuild goes via a scratch table because replacing a table while selecting
 * from it is not something to rely on.
 */
export async function overrideColumnType(
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const safeType = assertSupportedType(type)
  await initDuck()
  const conn = await requireDb().connect()
  const ident = quoteIdent(table)
  const col = quoteIdent(column)
  const scratch = quoteIdent(`${table}__recast`)

  try {
    await conn.query(
      `create or replace table ${scratch} as
       select * replace (try_cast(${col} as ${safeType}) as ${col}) from ${ident}`,
    )
    await conn.query(`drop table ${ident}`)
    await conn.query(`alter table ${scratch} rename to ${quoteIdent(table)}`)
  } finally {
    await conn.close()
  }
}

/**
 * Test seam. The CDN + blob-worker bootstrap above cannot run under Node, so the
 * integration test builds a Node-flavoured database and hands it in here; every
 * other function in this module is then exercised for real.
 */
export function attachDuck(instance: duckdb.AsyncDuckDB | null): void {
  db = instance
}
