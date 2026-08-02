/**
 * Shared shapes for AskSheet.
 *
 * This module deliberately imports nothing. `duck.ts` (which pulls in
 * `@duckdb/duckdb-wasm`) and `planClient.ts` (which pulls in `@labs/platform`)
 * both depend on these types, but the pure-logic modules — `profile.ts`,
 * `validate.ts`, `plan.ts` — depend only on this file plus `runtime.ts`. That
 * keeps the privacy-critical code testable in a bare Node process with no WASM
 * binary and no network client anywhere in the module graph.
 */

export interface ColumnInfo {
  name: string
  type: string
}

export interface QueryResult {
  columns: ColumnInfo[]
  rows: unknown[][]
  elapsedMs: number
  /** True when the result was clipped to the display row cap. */
  truncated: boolean
}

export interface ProfileColumn {
  name: string
  type: string
  /** Up to MAX_SAMPLES example values. Always empty in strict mode. */
  samples: string[]
}

/**
 * The complete set of information that ever crosses to the server.
 * If you are adding a field here, stop: you are changing the privacy contract.
 */
export interface Profile {
  table: string
  columns: ProfileColumn[]
  rowCount: number
}

export interface PlanHistoryItem {
  question: string
  sql: string
}

export interface PlanRepairContext {
  sql: string
  error: string
}

export interface PlanRequest {
  profile: Profile
  history: PlanHistoryItem[]
  question: string
  /** Present only on the second (repair) round-trip. */
  repair?: PlanRepairContext
}

export interface PlanResponse {
  sql: string
  narration: string
  /** Vega-Lite spec referencing only columns the SQL returns. */
  chart?: Record<string, unknown>
}

export interface Answer {
  sql: string
  narration: string
  chart?: Record<string, unknown>
  result: QueryResult
  /** True when the first planned statement failed and the second one worked. */
  repaired: boolean
}

export type QueryRunner = (sql: string, timeoutMs?: number) => Promise<QueryResult>
export type Planner = (request: PlanRequest) => Promise<PlanResponse>

/** The three collaborators `ask()` needs. Injectable so the loop is testable. */
export interface AskDeps {
  buildProfile: (table: string, strict: boolean) => Promise<Profile>
  requestPlan: Planner
  runQuery: QueryRunner
}
