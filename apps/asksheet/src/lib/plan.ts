import { buildProfile, disclosedTokens, redactProfile, redactSqlError } from './profile'
import { getPlanner, getQueryRunner } from './runtime'
import type {
  Answer,
  AskDeps,
  PlanHistoryItem,
  PlanRequest,
  PlanResponse,
  Profile,
  QueryResult,
} from './types'
import { assertSingleSelect } from './validate'

/**
 * The ask loop: profile → plan → validate → execute, with exactly one repair.
 *
 * One retry, not a loop. A second failure usually means the question cannot be
 * answered from this schema, and grinding through more round-trips spends the
 * user's daily quota to arrive at the same place more slowly. When it does fail,
 * both attempted statements are attached to the error so the UI can show the
 * work instead of a shrug.
 */

/** Prior turns handed to the planner. Older ones stop earning their tokens. */
export const MAX_HISTORY = 6

export class AskFailedError extends Error {
  /** The last statement attempted. */
  readonly sql: string
  /** Every statement attempted, in order. */
  readonly attempts: string[]

  constructor(message: string, attempts: string[]) {
    super(message)
    this.name = 'AskFailedError'
    this.attempts = attempts
    this.sql = attempts[attempts.length - 1] ?? ''
  }
}

export interface AskOptions {
  /** Prior question→SQL pairs. Never results — results are data. */
  history?: PlanHistoryItem[]
  /** Test seam. Production callers leave this alone. */
  deps?: Partial<AskDeps>
}

function resolveDeps(overrides: Partial<AskDeps> = {}): AskDeps {
  return {
    buildProfile: overrides.buildProfile ?? ((table, strict) => buildProfile(table, strict)),
    requestPlan: overrides.requestPlan ?? ((request) => getPlanner()(request)),
    runQuery: overrides.runQuery ?? ((sql, timeoutMs) => getQueryRunner()(sql, timeoutMs)),
  }
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}

type Outcome = { ok: true; result: QueryResult } | { ok: false; error: Error }

/** Validates then runs, recording the attempt either way. */
async function attempt(deps: AskDeps, response: PlanResponse, attempts: string[]): Promise<Outcome> {
  attempts.push(response.sql)
  try {
    assertSingleSelect(response.sql)
    return { ok: true, result: await deps.runQuery(response.sql) }
  } catch (thrown) {
    return { ok: false, error: asError(thrown) }
  }
}

function toAnswer(response: PlanResponse, result: QueryResult, repaired: boolean): Answer {
  return {
    sql: response.sql,
    narration: response.narration,
    ...(response.chart ? { chart: response.chart } : {}),
    result,
    repaired,
  }
}

/**
 * Answers one question against a locally registered table.
 *
 * The profile is re-redacted here even though `buildProfile` already redacted it.
 * That is not paranoia for its own sake: this is the last statement before the
 * only outbound call in the app, so it is the right place to make the payload
 * shape unconditional rather than dependent on an upstream function staying
 * correct. See `plan.test.ts` — one test breaks `buildProfile` on purpose.
 */
export async function ask(
  question: string,
  table: string,
  strict: boolean,
  options: AskOptions = {},
): Promise<Answer> {
  const deps = resolveDeps(options.deps)
  const history = (options.history ?? []).slice(-MAX_HISTORY)

  const built = await deps.buildProfile(table, strict)
  const profile: Profile = redactProfile(built, strict)

  const base: PlanRequest = { profile, history, question }

  const first = await deps.requestPlan(base)
  const attempts: string[] = []
  const firstOutcome = await attempt(deps, first, attempts)
  if (firstOutcome.ok) return toAnswer(first, firstOutcome.result, false)

  // The error text is the other half of the privacy boundary. DuckDB names the
  // offending cell in a conversion error, and a failed cast is the commonest
  // reason we are here at all — so the raw message must not be what goes out.
  // See `redactSqlError`; the full message is still what the user sees below.
  const error = redactSqlError(
    firstOutcome.error.message,
    disclosedTokens(profile, first.sql),
  )

  let second: PlanResponse
  try {
    second = await deps.requestPlan({ ...base, repair: { sql: first.sql, error } })
  } catch (thrown) {
    // The planner became unreachable (quota, network) between the two attempts.
    // Surfacing only that would throw away the SQL that actually failed, which is
    // the part the user can act on.
    throw new AskFailedError(
      `The query failed — ${firstOutcome.error.message} — and the retry could not be planned: ${asError(thrown).message}`,
      attempts,
    )
  }

  const secondOutcome = await attempt(deps, second, attempts)
  if (secondOutcome.ok) return toAnswer(second, secondOutcome.result, true)

  throw new AskFailedError(
    `The query failed: ${firstOutcome.error.message} — the corrected query also failed: ${secondOutcome.error.message}`,
    attempts,
  )
}
