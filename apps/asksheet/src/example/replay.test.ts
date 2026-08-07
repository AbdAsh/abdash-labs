import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootNodeDuck } from '../../test/nodeDuck'
import { toChartSpec } from '../lib/chart'
import { attachDuck, registerCsv, resetDuck, runQuery } from '../lib/duck'
import { assertSingleSelect } from '../lib/validate'
import { EXAMPLE, exampleSample } from './index'

/**
 * The finished example, actually finished.
 *
 * `example.test.ts` checks the recording; this runs it. Every saved statement is
 * executed against the real bundled CSV in a real DuckDB, which is the only way
 * to know that clicking a question produces an answer rather than an error — and
 * it is exactly what the browser does, minus the browser.
 *
 * It also pins the outcome of the headline question. "The bundled sample answers
 * *which month had the highest revenue*" is a stated success criterion, and the
 * example path is now the first place a visitor meets it.
 */

const TABLE = EXAMPLE.table

describe('replaying the saved plans', () => {
  beforeAll(async () => {
    attachDuck(await bootNodeDuck())
    await registerCsv(exampleSample().csv, TABLE)
  }, 120_000)

  afterAll(async () => {
    await resetDuck()
  })

  for (const [index, plan] of EXAMPLE.plans.entries()) {
    describe(`${index + 1}. ${plan.question}`, () => {
      it('runs, and returns the shape it returned when it was captured', async () => {
        assertSingleSelect(plan.sql)
        const result = await runQuery(plan.sql)
        expect(result.columns.map((column) => column.name)).toEqual(plan.observed.columns)
        expect(result.rows).toHaveLength(plan.observed.rowCount)
      })

      it('returns rows, so the visitor is not shown an empty table', async () => {
        const result = await runQuery(plan.sql)
        expect(result.rows.length).toBeGreaterThan(0)
      })

      const chart = plan.chart
      if (chart) {
        it('has a chart spec that survives validation against its own result', async () => {
          const result = await runQuery(plan.sql)
          // Same path the UI takes: fields the spec names must exist in the result,
          // or `toChartSpec` drops it and the answer silently loses its picture.
          expect(toChartSpec(chart, result)).not.toBeNull()
        })
      }
    })
  }

  it('names the outlier month, which is the whole point of the sample', async () => {
    const result = await runQuery(EXAMPLE.plans[0]!.sql)
    expect(String(result.rows[0]![0])).toBe('2025-03')
  })
})
