import type { Planner, QueryRunner } from './types'

/**
 * A one-line dependency seam.
 *
 * `profile.ts` and `plan.ts` need to run SQL and to call the planner, but if they
 * imported `duck.ts` or `planClient.ts` directly the whole DuckDB WASM bundle and
 * the Supabase client would be dragged into every unit test. Instead `bootstrap.ts`
 * registers the real implementations once at startup, and tests either inject
 * fakes at the call site or register them here.
 */

let queryRunner: QueryRunner | null = null
let planner: Planner | null = null

export function setQueryRunner(runner: QueryRunner | null): void {
  queryRunner = runner
}

export function getQueryRunner(): QueryRunner {
  if (!queryRunner) {
    throw new Error('No query runner registered. Call setQueryRunner() during startup.')
  }
  return queryRunner
}

export function setPlanner(next: Planner | null): void {
  planner = next
}

export function getPlanner(): Planner {
  if (!planner) {
    throw new Error('No planner registered. Call setPlanner() during startup.')
  }
  return planner
}
