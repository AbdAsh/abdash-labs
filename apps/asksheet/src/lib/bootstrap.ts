import { runQuery } from './duck'
import { requestPlan } from './planClient'
import { setPlanner, setQueryRunner } from './runtime'

/**
 * Wires the real DuckDB and the real planner into the registry that `profile.ts`
 * and `plan.ts` read from. Called once from `main.tsx`.
 *
 * This module exists so that those two files — the ones carrying the privacy
 * logic — import neither the WASM bundle nor the network client, and can be
 * unit-tested in a bare Node process.
 */
export function bootstrap(): void {
  setQueryRunner(runQuery)
  setPlanner(requestPlan)
}
