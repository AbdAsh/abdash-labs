import { describe, expect, it, vi } from 'vitest'
import { AskFailedError, MAX_HISTORY, ask } from './plan'
import { redactProfile } from './profile'
import type { AskDeps, PlanRequest, PlanResponse, Profile, QueryResult } from './types'

const profile: Profile = redactProfile(
  {
    table: 'data',
    rowCount: 216,
    columns: [
      { name: 'month', type: 'VARCHAR', samples: ['2024-01', '2024-02'] },
      { name: 'revenue_usd', type: 'DOUBLE', samples: ['1200.5'] },
    ],
  },
  false,
)

const okResult: QueryResult = {
  columns: [{ name: 'month', type: 'VARCHAR' }],
  rows: [['2025-03']],
  elapsedMs: 4,
  truncated: false,
}

const VALID = 'select month, sum(revenue_usd) as revenue from data group by 1 order by 2 desc'
const INVALID_SQL = 'drop table data'

/** Builds a deps bundle whose planner returns the given responses in order. */
function harness(responses: (PlanResponse | Error)[], runQuery?: AskDeps['runQuery']) {
  const requests: PlanRequest[] = []
  const executed: string[] = []

  const deps: AskDeps = {
    buildProfile: vi.fn(async () => profile),
    requestPlan: vi.fn(async (request: PlanRequest) => {
      requests.push(structuredClone(request))
      const next = responses.shift()
      if (!next) throw new Error('planner called more times than the test allows')
      if (next instanceof Error) throw next
      return next
    }),
    runQuery:
      runQuery ??
      vi.fn(async (sql: string) => {
        executed.push(sql)
        return okResult
      }),
  }
  return { deps, requests, executed }
}

const plan = (sql: string, narration = 'Here you go.'): PlanResponse => ({ sql, narration })

describe('ask — happy path', () => {
  it('profiles, plans, validates, runs and reports repaired: false', async () => {
    const { deps, executed } = harness([plan(VALID, 'March is the outlier.')])
    const answer = await ask('which month had the highest revenue?', 'data', false, { deps })

    expect(answer.repaired).toBe(false)
    expect(answer.sql).toBe(VALID)
    expect(answer.narration).toBe('March is the outlier.')
    expect(answer.result).toBe(okResult)
    expect(executed).toEqual([VALID])
    expect(deps.requestPlan).toHaveBeenCalledTimes(1)
  })

  it('passes the strict flag straight through to buildProfile', async () => {
    const { deps } = harness([plan(VALID)])
    await ask('q', 'data', true, { deps })
    expect(deps.buildProfile).toHaveBeenCalledWith('data', true)
  })

  it('forwards prior question/SQL pairs as history and never any results', async () => {
    const { deps, requests } = harness([plan(VALID)])
    await ask('now only 2025', 'data', false, {
      deps,
      history: [{ question: 'revenue by month?', sql: VALID }],
    })
    expect(requests[0]!.history).toEqual([{ question: 'revenue by month?', sql: VALID }])
    expect(JSON.stringify(requests[0])).not.toContain('rows')
  })

  it('sends at most MAX_HISTORY prior turns, keeping the most recent', async () => {
    const { deps, requests } = harness([plan(VALID)])
    const history = Array.from({ length: MAX_HISTORY + 4 }, (_v, i) => ({
      question: `q${i}`,
      sql: VALID,
    }))
    await ask('q', 'data', false, { deps, history })
    expect(requests[0]!.history).toHaveLength(MAX_HISTORY)
    expect(requests[0]!.history[MAX_HISTORY - 1]!.question).toBe(`q${MAX_HISTORY + 3}`)
  })

  it('carries the optional chart spec onto the answer', async () => {
    const chart = { mark: 'bar', encoding: { x: { field: 'month' } } }
    const { deps } = harness([{ sql: VALID, narration: 'n', chart }])
    const answer = await ask('q', 'data', false, { deps })
    expect(answer.chart).toEqual(chart)
  })
})

describe('ask — one-shot repair', () => {
  it('repairs unsafe SQL and executes only the valid statement', async () => {
    const { deps, executed } = harness([plan(INVALID_SQL), plan(VALID)])
    const answer = await ask('q', 'data', false, { deps })

    expect(answer.repaired).toBe(true)
    expect(answer.sql).toBe(VALID)
    expect(executed).toEqual([VALID]) // the rejected statement never reached DuckDB
    expect(deps.requestPlan).toHaveBeenCalledTimes(2)
  })

  it('repairs a statement that validates but blows up inside DuckDB', async () => {
    const executed: string[] = []
    const runQuery = vi.fn(async (sql: string) => {
      executed.push(sql)
      if (sql.includes('no_such_column')) throw new Error('Binder Error: no_such_column')
      return okResult
    })
    const broken = 'select no_such_column from data'
    const { deps } = harness([plan(broken), plan(VALID)], runQuery)

    const answer = await ask('q', 'data', false, { deps })
    expect(answer.repaired).toBe(true)
    expect(executed).toEqual([broken, VALID])
  })

  it('sends the failing SQL and the error text on the repair round-trip', async () => {
    const { deps, requests } = harness([plan(INVALID_SQL), plan(VALID)])
    await ask('q', 'data', false, { deps })

    expect(requests[0]!.repair).toBeUndefined()
    expect(requests[1]!.repair?.sql).toBe(INVALID_SQL)
    expect(requests[1]!.repair?.error).toMatch(/drop/i)
  })

  /**
   * The leak this pass was sent to find.
   *
   * DuckDB names the offending cell in a conversion error, and the system prompt
   * tells the planner to cast text that holds numbers — so a failed cast is the
   * single likeliest reason a repair happens at all. `repair.error` was the raw
   * message. Shape correct, key count correct, contents a row value.
   */
  it('never forwards a cell value that DuckDB quoted in its error message', async () => {
    const secret = '111-22-3333'
    const runQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('cast')) {
        throw new Error(
          `Conversion Error: Could not convert string '${secret}' to INT32 when casting from source column revenue_usd\n\nLINE 2: select cast(revenue_usd as integer) from data\n               ^`,
        )
      }
      return okResult
    })
    const { deps, requests } = harness(
      [plan('select cast(revenue_usd as integer) from data'), plan(VALID)],
      runQuery,
    )

    await ask('q', 'data', false, { deps })
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests)).not.toContain(secret)
    // The diagnosis still travels, or the repair round-trip is worthless.
    expect(requests[1]!.repair?.error).toMatch(/conversion error/i)
    expect(requests[1]!.repair?.error).toContain('revenue_usd')
  })

  it('never forwards a cell value DuckDB echoed on its own line', async () => {
    const secret = 'severe migraine'
    const runQuery = vi.fn(async (): Promise<QueryResult> => {
      throw new Error(
        `Invalid Input Error: Could not parse string "${secret}" according to format specifier "%Y-%m-%d"\n${secret}\n^\nError: Expected a number`,
      )
    })
    const { deps, requests } = harness([plan('select strptime(month, \'%Y-%m-%d\') from data'), plan(VALID)], runQuery)

    await ask('q', 'data', false, { deps }).catch(() => undefined)
    expect(JSON.stringify(requests)).not.toContain(secret)
  })

  it('keeps the full error locally even though the redacted one goes out', async () => {
    const secret = '111-22-3333'
    const runQuery = vi.fn(async (): Promise<QueryResult> => {
      throw new Error(`Conversion Error: Could not convert string '${secret}' to INT32`)
    })
    const { deps, requests } = harness([plan(VALID), plan(VALID)], runQuery)

    const failure = (await ask('q', 'data', false, { deps }).catch((e: unknown) => e)) as AskFailedError
    // The user is shown what actually happened — it is their own data, on their
    // own screen. Only the copy that crosses the network is redacted.
    expect(failure.message).toContain(secret)
    expect(JSON.stringify(requests)).not.toContain(secret)
  })

  it('profiles once, not twice, across the repair', async () => {
    const { deps } = harness([plan(INVALID_SQL), plan(VALID)])
    await ask('q', 'data', false, { deps })
    expect(deps.buildProfile).toHaveBeenCalledTimes(1)
  })

  it('sends the identical profile object on both round-trips', async () => {
    const { deps, requests } = harness([plan(INVALID_SQL), plan(VALID)])
    await ask('q', 'data', false, { deps })
    expect(requests[1]!.profile).toEqual(requests[0]!.profile)
  })

  it('never attempts a third round-trip', async () => {
    const { deps } = harness([plan(INVALID_SQL), plan(INVALID_SQL)])
    await expect(ask('q', 'data', false, { deps })).rejects.toThrow(AskFailedError)
    expect(deps.requestPlan).toHaveBeenCalledTimes(2)
  })
})

describe('ask — persistent failure is surfaced honestly', () => {
  it('surfaces the original error when the second attempt also fails', async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes('first')) throw new Error('Binder Error: FIRST FAILURE')
      throw new Error('Binder Error: SECOND FAILURE')
    })
    const { deps } = harness([plan('select first from data'), plan('select second from data')], runQuery)

    const error = await ask('q', 'data', false, { deps }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AskFailedError)
    const failure = error as AskFailedError
    expect(failure.message).toContain('FIRST FAILURE')
    expect(failure.message).toContain('SECOND FAILURE')
  })

  it('exposes every attempted statement so the UI can show the work', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('boom')
    })
    const { deps } = harness([plan('select a from data'), plan('select b from data')], runQuery)

    const failure = (await ask('q', 'data', false, { deps }).catch((e: unknown) => e)) as AskFailedError
    expect(failure.attempts).toEqual(['select a from data', 'select b from data'])
    expect(failure.sql).toBe('select b from data')
  })

  it('does not swallow a planner transport failure into a repair loop', async () => {
    const { deps } = harness([new Error('OpenRouter 429: quota')])
    await expect(ask('q', 'data', false, { deps })).rejects.toThrow(/429/)
    expect(deps.requestPlan).toHaveBeenCalledTimes(1)
  })

  /**
   * Hitting the quota wall between the two attempts used to throw away the SQL
   * that actually failed, so the user was told "daily limit reached" and never
   * shown the query — the one thing they could have acted on.
   */
  it('keeps the first attempt when the retry cannot even be planned', async () => {
    const runQuery = vi.fn(async (): Promise<QueryResult> => {
      throw new Error('Binder Error: FIRST FAILURE')
    })
    const { deps } = harness(
      [plan('select a from data'), new Error('Daily limit reached for asksheet:plans.')],
      runQuery,
    )

    const failure = (await ask('q', 'data', false, { deps }).catch((e: unknown) => e)) as AskFailedError
    expect(failure).toBeInstanceOf(AskFailedError)
    expect(failure.attempts).toEqual(['select a from data'])
    expect(failure.message).toContain('FIRST FAILURE')
    expect(failure.message).toMatch(/daily limit/i)
  })

  it('fails loudly when the planner returns no SQL at all', async () => {
    const { deps } = harness([{ sql: '', narration: 'n' }, { sql: '', narration: 'n' }])
    await expect(ask('q', 'data', false, { deps })).rejects.toThrow(AskFailedError)
  })
})

describe('ask — the privacy invariant, end to end', () => {
  it('sends nothing beyond profile, history, question and repair', async () => {
    const { deps, requests } = harness([plan(INVALID_SQL), plan(VALID)])
    await ask('q', 'data', false, { deps, history: [{ question: 'p', sql: VALID }] })

    expect(Object.keys(requests[0]!).sort()).toEqual(['history', 'profile', 'question'])
    expect(Object.keys(requests[1]!).sort()).toEqual(['history', 'profile', 'question', 'repair'])
    for (const request of requests) {
      expect(Object.keys(request.profile).sort()).toEqual(['columns', 'rowCount', 'table'])
    }
  })

  it('never forwards a query result to the planner, even after a repair', async () => {
    const secret = 'CONFIDENTIAL-CELL-VALUE'
    const runQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql === INVALID_SQL) throw new Error('nope')
      return {
        columns: [{ name: 'x', type: 'VARCHAR' }],
        rows: [[secret]],
        elapsedMs: 1,
        truncated: false,
      }
    })
    const { deps, requests } = harness([plan(VALID), plan(VALID)], runQuery)
    await ask('q', 'data', false, { deps })
    expect(JSON.stringify(requests)).not.toContain(secret)
  })

  it('re-redacts whatever buildProfile handed back before it goes out', async () => {
    const { deps, requests } = harness([plan(VALID)])
    // A buildProfile that has been broken by a future refactor.
    deps.buildProfile = vi.fn(async () => ({ ...profile, rows: [['leak@example.com']] }) as Profile)
    await ask('q', 'data', false, { deps })
    expect(JSON.stringify(requests[0]!.profile)).not.toContain('leak@example.com')
    expect(Object.keys(requests[0]!.profile).sort()).toEqual(['columns', 'rowCount', 'table'])
  })
})
