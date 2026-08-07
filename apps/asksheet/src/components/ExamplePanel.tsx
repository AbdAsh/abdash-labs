import { capturedOn, EXAMPLE, type ExamplePlan } from '../example'

/**
 * The finished-example path.
 *
 * Two halves, and the whole panel exists to keep them apart in the reader's
 * head: the SQL was written by the planner on a date in the past and saved; the
 * numbers it produces are computed by DuckDB in this tab, now, from the bundled
 * CSV. Neither half is faked, and neither is quietly presented as the other.
 *
 * The privacy consequence is stronger here than on the live path, so it is
 * stated rather than left to be noticed: replaying a saved plan makes no request
 * at all — not the one per question the live path makes, none.
 */
export function ExamplePanel({
  shown,
  busy,
  ready,
  onRun,
  onAskYourOwn,
}: {
  /** Indices already replayed into the transcript. */
  shown: number[]
  busy: boolean
  /** False until the sample is registered in DuckDB. */
  ready: boolean
  onRun: (index: number) => void
  onAskYourOwn: () => void
}) {
  return (
    <section className="panel example" aria-labelledby="example-heading">
      <h2 id="example-heading">A finished example</h2>

      <p className="example-lede">
        Three questions that were put to the planner on {capturedOn()}. The SQL it wrote back is
        saved in this page; clicking one runs that SQL against the bundled sample in the DuckDB
        already loaded in this tab.
      </p>

      <dl className="example-split">
        <dt>replayed</dt>
        <dd>The SQL, the sentence above each table, and the chart spec — planned once, saved.</dd>
        <dt>computed now</dt>
        <dd>
          Every number, every row, every bar. Nothing below is a stored result; the query runs on
          your machine when you click.
        </dd>
        <dt>network</dt>
        <dd>
          None. Open DevTools → Network first if you like: the live path sends one request per
          question, this path sends nothing at all — and there is no session either, because
          nothing here needs an account. The engine and the chart renderer download when the page
          loads, before any of this. That is the engine coming to the data, and it is the only
          traffic there is.
        </dd>
      </dl>

      <ol className="example-questions">
        {EXAMPLE.plans.map((plan, index) => (
          <li key={plan.question}>
            <button
              type="button"
              className={`example-question${shown.includes(index) ? ' is-shown' : ''}`}
              disabled={busy || !ready}
              onClick={() => onRun(index)}
            >
              <span className="q">{plan.question}</span>
              <span className="tags">{tagsFor(plan)}</span>
            </button>
          </li>
        ))}
      </ol>

      {!ready && (
        <p className="meta-line">
          <span className="spinner" aria-hidden="true" /> Loading the sample into DuckDB…
        </p>
      )}

      <p className="example-footer">
        <button type="button" className="link" onClick={onAskYourOwn}>
          Ask your own question instead
        </button>{' '}
        — same sample or your own CSV, planned live. That one does spend a question from your daily
        allowance, and does make the one request.
      </p>
    </section>
  )
}

/** Everything the badges say is read off the recording, so it cannot drift away
 *  from what the fixture actually contains. */
function tagsFor(plan: ExamplePlan): string {
  const tags: string[] = []
  if (plan.follows !== null) {
    tags.push(`follow-up to ${plan.follows + 1} — planned from its SQL, never its results`)
  }
  if (plan.chart) tags.push('the planner returned a chart')
  if (plan.repaired) tags.push('needed a corrected second attempt')
  tags.push(`${plan.requestBytes} bytes left the tab to plan this`)
  return tags.join(' · ')
}
