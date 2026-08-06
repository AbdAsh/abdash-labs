import { useState } from 'react'
import { configLabel, isUnreachable, type ConfigResult, type PerQuestionResult } from '../lib/engine'
import { minChunkSizeToHit, type Question } from '../lib/metrics'

const pct = (n: number) => `${Math.round(n * 100)}%`

type Verdict =
  | { kind: 'hit'; rank: number }
  | { kind: 'depth'; rank: number }
  | { kind: 'boundary' }
  | { kind: 'impossible'; minSize: number }

/**
 * Why one configuration got this question wrong.
 *
 * Three failures share a score of zero and have nothing else in common, and
 * separating them is the whole value of this view:
 *
 *   `impossible` — the answer is longer than twice the chunk size, so no chunk
 *     can cover half of it. Arithmetic, not retrieval. Tuning the model here is
 *     wasted work.
 *   `boundary` — some chunk touched the answer but none contained enough of it.
 *     The chunker cut through the passage; overlap or a larger size is the fix.
 *   `depth` — the right chunk existed and the embedding ranked it, just below the
 *     cutoff. Raising k fixes this and nothing about the chunking needs to change.
 */
export function verdictFor(
  outcome: PerQuestionResult,
  result: ConfigResult,
  gold: Question['gold'],
): Verdict {
  // `?? null` rather than `!== null`: a run persisted before these fields
  // existed has `undefined` here, and `undefined !== null` is true — the
  // untreated version reads a missing rank as a real one and renders "#undefined".
  const rank = outcome.firstHitRank ?? null
  if (outcome.hit) return { kind: 'hit', rank: rank ?? 1 }
  if (rank !== null) return { kind: 'depth', rank }
  if (isUnreachable(gold, result.config)) {
    return { kind: 'impossible', minSize: minChunkSizeToHit(gold) }
  }
  return { kind: 'boundary' }
}

function Diagnosis({
  verdict, outcome, result,
}: {
  verdict: Verdict
  outcome: PerQuestionResult
  result: ConfigResult
}) {
  switch (verdict.kind) {
    case 'hit':
      return <span className="ok">found at #{verdict.rank}</span>
    case 'depth':
      return (
        <span>
          <strong>Ranking, not chunking.</strong> The right chunk existed and ranked
          {' '}#{verdict.rank} of {result.chunkCount} — k={result.config.k} cut it off.
          {' '}At k={verdict.rank} this config would score{' '}
          {(1 / verdict.rank).toFixed(2)} on this question instead of 0.
        </span>
      )
    case 'boundary':
      return (
        <span>
          <strong>The chunker split the answer.</strong>{' '}
          {outcome.bestOverlap === null
            ? 'No chunk covered the half of it a hit needs.'
            : `The best chunk covered ${pct(outcome.bestOverlap)} of it, under the 50% needed.`}
          {' '}More overlap than {result.config.overlap}, or a size above{' '}
          {result.config.size}, keeps the passage together.
        </span>
      )
    case 'impossible':
      return (
        <span>
          <strong>Impossible at this chunk size.</strong> A {result.config.size}-character
          chunk cannot hold half of this answer — it would need at least{' '}
          {verdict.minSize}. Every embedding model scores 0 here; nothing about
          retrieval is being measured.
        </span>
      )
  }
}

/**
 * Per-question diagnostics: which configurations missed, what they retrieved
 * instead, and why that retrieval lost.
 *
 * This is the view that justifies building the tool. A leaderboard says config A
 * beat config B. This says the answer to question 7 ranked #14 under a 1600-character
 * chunking and #2 under a 400-character one, so the problem was never the model —
 * and that is a thing a reader can act on. Scores rank; this teaches.
 *
 * It renders from the persisted result alone, without the document, because the
 * audience for a benchmark permalink is someone who has the link and nothing else.
 * The gold passage travels with the question set for exactly that reason.
 */
export function QuestionDrilldown({
  questions, results, text,
}: {
  questions: Question[]
  results: ConfigResult[]
  text?: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  if (results.length === 0 || questions.length === 0) return null

  const goldPassage = (q: Question) =>
    (text ? text.slice(q.gold.start, q.gold.end) : q.goldText) ?? null

  const rows = questions.map((question) => {
    const perConfig = results
      .map((result) => ({
        result,
        outcome: result.perQuestion.find((p) => p.questionId === question.id),
      }))
      .filter((p): p is { result: ConfigResult; outcome: PerQuestionResult } => !!p.outcome)
      .map((p) => ({ ...p, verdict: verdictFor(p.outcome, p.result, question.gold) }))

    const missed = perConfig.filter((p) => p.verdict.kind !== 'hit')
    return { question, perConfig, missed }
  })

  // Hardest questions first: a question every config answers teaches nothing.
  rows.sort((a, b) => b.missed.length - a.missed.length)

  return (
    <section className="panel">
      <h2>Per-question diagnostics</h2>
      <p className="lede">
        Sorted by difficulty. Every miss is labelled with the reason it missed —
        a chunk size that cannot hold the answer, a chunker that cut through it,
        or a ranking that found it and buried it below k. Those three look
        identical in the metrics and need three different fixes.
      </p>

      <ul className="drilldown">
        {rows.map(({ question, perConfig, missed }) => {
          const isOpen = open === question.id
          const passage = goldPassage(question)
          const impossible = missed.filter((m) => m.verdict.kind === 'impossible')
          return (
            <li key={question.id}>
              <button
                type="button"
                className="drill-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : question.id)}
              >
                <span className={missed.length === 0 ? 'pill ok' : 'pill warn'}>
                  {perConfig.length - missed.length}/{perConfig.length}
                </span>
                <span className="drill-q">{question.text || <em>untitled question</em>}</span>
              </button>

              {isOpen && (
                <div className="drill-body">
                  {passage
                    ? (
                      <p className="gold-preview">
                        <span className="dim">Gold: </span>
                        <mark>{passage}</mark>
                      </p>
                    )
                    : (
                      <p className="gold-preview empty">
                        Gold span [{question.gold.start}, {question.gold.end}) —{' '}
                        {question.gold.end - question.gold.start} characters. The passage
                        itself is not part of this permalink.
                      </p>
                    )}

                  {impossible.length > 0 && (
                    <p className="warn">
                      {impossible.length} configuration{impossible.length === 1 ? '' : 's'}{' '}
                      cannot reach this answer at all: it is{' '}
                      {question.gold.end - question.gold.start} characters and needs a chunk
                      of at least {minChunkSizeToHit(question.gold)} to cover half of it.
                      Their zeros say nothing about retrieval.
                    </p>
                  )}

                  {missed.length === 0
                    ? <p className="ok">Every configuration found this one.</p>
                    : (
                      <>
                        <h4>
                          Missed by {missed.length} configuration{missed.length === 1 ? '' : 's'}
                        </h4>
                        {missed.map(({ result, outcome, verdict }) => (
                          <div key={configLabel(result.config)} className="miss">
                            <div className="miss-config">{configLabel(result.config)}</div>
                            <p className="miss-why">
                              <Diagnosis verdict={verdict} outcome={outcome} result={result} />
                            </p>
                            <ol className="miss-retrieved">
                              {outcome.retrieved.map((excerpt, i) => (
                                <li key={`${outcome.questionId}-${i}`}>
                                  <span className="rank">{i + 1}</span> {excerpt}
                                </li>
                              ))}
                              {outcome.retrieved.length === 0 && (
                                <li className="dim">nothing retrieved</li>
                              )}
                            </ol>
                          </div>
                        ))}
                      </>
                    )}

                  <h4>Where the answer ranked, per configuration</h4>
                  <ul className="rank-list">
                    {perConfig.map(({ result, outcome, verdict }) => (
                      <li key={`rank-${configLabel(result.config)}`}>
                        <span className="dim">{configLabel(result.config)}</span>
                        <strong className={outcome.hit ? 'ok' : 'warn'}>
                          {verdict.kind === 'hit' || verdict.kind === 'depth'
                            ? `#${verdict.rank} of ${result.chunkCount}${outcome.hit ? '' : ` — past k=${result.config.k}`}`
                            : verdict.kind === 'impossible'
                              ? 'unreachable at this size'
                              : outcome.bestOverlap === null
                                ? 'no chunk over 50%'
                                : `no chunk over 50% (best ${pct(outcome.bestOverlap)})`}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
