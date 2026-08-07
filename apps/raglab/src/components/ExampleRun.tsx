import { useMemo, type ReactNode } from 'react'
import { chunkerLabel } from '../lib/chunkers'
import { configLabel } from '../lib/engine'
import { EXAMPLE_RUN, type ExampleRunFixture } from '../example'
import { SAMPLE_DOC } from '../samples/founding-documents'
import { Leaderboard } from './Leaderboard'
import { MetricChart } from './MetricChart'
import { QuestionDrilldown, verdictFor } from './QuestionDrilldown'

/**
 * The finished benchmark a visitor lands on.
 *
 * The live product is unchanged and one click away; this exists because the live
 * product costs ninety seconds and two of an anonymous visitor's daily runs, and
 * a reviewer will spend neither. What they get instead is not a screenshot and
 * not a mock-up: it is a benchmark that actually ran, recorded by
 * `scripts/record-example.mjs` against the deployed embedding function and
 * rendered through the same three components the Run button feeds.
 *
 * Everything on this page is read out of the fixture or derived from it in the
 * render. Nothing is a literal typed by a human — which is the only way a page
 * making claims about honest measurement can be worth reading.
 */

const oneDp = (n: number) => n.toFixed(1)

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Counts the three failure modes across every question × configuration pair,
 * using the drill-down's own classifier.
 *
 * Recomputed at render rather than stored in the fixture. A stored total is a
 * number that can drift out of step with the results it summarises; a derived
 * one cannot, and this app has no business shipping a headline figure that
 * disagrees with the table underneath it.
 */
export function outcomeCounts(run: ExampleRunFixture) {
  const goldById = new Map(run.questions.map((q) => [q.id, q.gold]))
  const counts = { total: 0, hit: 0, depth: 0, boundary: 0, impossible: 0 }
  for (const result of run.results) {
    for (const outcome of result.perQuestion) {
      const gold = goldById.get(outcome.questionId)
      if (!gold) continue
      counts.total += 1
      counts[verdictFor(outcome, result, gold).kind] += 1
    }
  }
  return counts
}

/**
 * One line of the failure breakdown.
 *
 * A zero is annotated rather than hidden. Dropping the row would leave a reader
 * thinking this run demonstrated three kinds of failure when it demonstrated two,
 * and the missing one is a real result about this document: every gold passage
 * here is a single clause, so no chunker ever cut one in half. Saying "none in
 * this run" is the difference between reporting a measurement and curating one.
 */
function Outcome({
  n, tone, children,
}: {
  n: number
  tone: 'ok' | 'warn'
  children: ReactNode
}) {
  return (
    <li className={n === 0 ? 'empty' : undefined}>
      <strong className={n === 0 ? 'dim' : tone}>{n}</strong> {children}
      {n === 0 && <em className="dim"> None in this run.</em>}
    </li>
  )
}

export function ExampleRun({ onRunYourOwn }: { onRunYourOwn: () => void }) {
  const { provenance, document: doc, matrix, questions, results } = EXAMPLE_RUN
  const counts = useMemo(() => outcomeCounts(EXAMPLE_RUN), [])

  const ranked = useMemo(
    () => [...results].sort((a, b) => (b.mrr - a.mrr) || (b.hitRate - a.hitRate)),
    [results],
  )
  const winner = ranked[0]
  const winnerMisses = winner?.perQuestion.filter((p) => !p.hit).length ?? 0

  return (
    <>
      <section className="panel example-head">
        <h2>A finished benchmark</h2>
        <p className="example-label">
          Saved real run from {formatDate(provenance.capturedAt)}
        </p>
        <p className="lede">
          {results.length} configurations over {questions.length} hand-labelled questions,
          scored against the deployed embedding function in{' '}
          {oneDp(provenance.elapsedMs / 1000)} seconds and{' '}
          {provenance.vectorsPurchased.toLocaleString()} embeddings. It is here because
          running it yourself costs that minute and one of two daily runs, and because a
          benchmarking tool that opened on invented numbers would not deserve the rest of
          this page. Nothing below was typed by hand.
        </p>

        <dl className="estimate">
          <div>
            <dt>Configurations</dt>
            <dd>{results.length}</dd>
          </div>
          <div>
            <dt>Questions</dt>
            <dd>{questions.length}</dd>
          </div>
          <div>
            <dt>Embeddings bought</dt>
            <dd>{provenance.vectorsPurchased.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Wall clock</dt>
            <dd>{oneDp(provenance.elapsedMs / 1000)} s</dd>
          </div>
          <div>
            <dt>Quota charged</dt>
            <dd>{provenance.quotaUnits}</dd>
          </div>
        </dl>

        <p className="doc-summary example-meta">
          <strong>{doc.title}</strong> · {doc.characters.toLocaleString()} characters ·{' '}
          {doc.source} · {doc.license}.
        </p>
        <p className="doc-summary example-meta">
          Chunkers: {matrix.chunkers.map(chunkerLabel).join(', ')} · sizes{' '}
          {matrix.sizes.join(' and ')} with {matrix.overlaps.join('/')} overlap · k={matrix.ks.join('/')} ·{' '}
          {provenance.models.map((m) => `${m.label} (${m.dims ?? '?'} dims)`).join(' and ')}.
          A chunk counted as a hit at {Math.round(provenance.hitThreshold * 100)}% coverage
          of the labelled answer.
        </p>
        <p className="doc-summary example-meta">
          {provenance.httpBatches} batched calls to <code>raglab-embed</code> under{' '}
          {provenance.runIds} run {provenance.runIds === 1 ? 'id' : 'ids'}
          {provenance.runIds === 1
            ? ` — which is why all ${results.length} configurations cost one unit of the `
              + `daily allowance instead of ${results.length}.`
            : '.'}
          {provenance.cacheAssisted && ' Some vectors were reused from a local cache.'}
        </p>

        <div className="toolbar example-actions">
          <button type="button" className="primary" onClick={onRunYourOwn}>
            Run your own benchmark
          </button>
          <span className="dim">Your document, your questions, your matrix.</span>
        </div>
      </section>

      <section className="panel">
        <h2>What it found</h2>
        <p className="lede">
          {counts.total} question × configuration outcomes. The split is the reason this
          app exists: a single zero in a leaderboard hides three unrelated problems, and
          only one of them is about the embedding model.
        </p>
        <ul className="outcome-split">
          <Outcome n={counts.hit} tone="ok">
            found the answer inside the top-k results.
          </Outcome>
          <Outcome n={counts.depth} tone="warn">
            ranked the right chunk and then discarded it below the cutoff. Raise k;
            the chunking is fine.
          </Outcome>
          <Outcome n={counts.boundary} tone="warn">
            had the chunker cut through the answer, so no single chunk held enough of it.
          </Outcome>
          <Outcome n={counts.impossible} tone="warn">
            were arithmetically out of reach: the chunk was smaller than half the labelled
            answer, so every embedding model scores zero and nothing about retrieval was
            measured.
          </Outcome>
        </ul>
        {winner && winnerMisses > 0 && (
          <p className="lede example-winner-note">
            Even the winner — {configLabel(winner.config)} — missed {winnerMisses} of{' '}
            {winner.perQuestion.length}. Open{' '}
            {winnerMisses === 1 ? 'that question' : 'those questions'} below to see which
            kind of failure it was; the drill-down names it and says what to change.
          </p>
        )}
      </section>

      <Leaderboard results={results} />
      <MetricChart results={results} />
      <QuestionDrilldown questions={questions} results={results} text={SAMPLE_DOC.text} />
    </>
  )
}
