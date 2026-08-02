import { useState } from 'react'
import type { ConfigResult } from '../lib/engine'
import type { Question } from '../lib/metrics'
import { configLabel } from './Leaderboard'

/**
 * Per-question diagnostics: which configurations missed, and what they retrieved
 * instead.
 *
 * This is the view that justifies building the tool. A leaderboard tells you
 * config A beat config B; this tells you *why* — that at 1600 characters the
 * answer to question 7 sits in the same chunk as three unrelated clauses and the
 * embedding drowns, and that halving the chunk size fixes it. Scores rank; this
 * teaches.
 */
export function QuestionDrilldown({
  questions, results, text,
}: {
  questions: Question[]
  results: ConfigResult[]
  text: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  if (results.length === 0) return null

  const rows = questions.map((question) => {
    const perConfig = results.map((r) => ({
      result: r,
      outcome: r.perQuestion.find((p) => p.questionId === question.id),
    }))
    const missed = perConfig.filter((p) => p.outcome && !p.outcome.hit)
    return { question, perConfig, missed }
  })

  // Hardest questions first: a question every config answers teaches nothing.
  rows.sort((a, b) => b.missed.length - a.missed.length)

  return (
    <section className="panel">
      <h2>Per-question diagnostics</h2>
      <p className="lede">
        Sorted by difficulty. A question no configuration reaches is usually a
        labelling problem, not a retrieval one — worth checking the span before
        blaming the chunker.
      </p>

      <ul className="drilldown">
        {rows.map(({ question, perConfig, missed }) => {
          const isOpen = open === question.id
          return (
            <li key={question.id}>
              <button
                type="button"
                className="drill-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : question.id)}
              >
                <span className={missed.length === 0 ? 'pill ok' : 'pill warn'}>
                  {results.length - missed.length}/{results.length}
                </span>
                <span className="drill-q">{question.text}</span>
              </button>

              {isOpen && (
                <div className="drill-body">
                  <p className="gold-preview">
                    <span className="dim">Gold: </span>
                    <mark>{text.slice(question.gold.start, question.gold.end)}</mark>
                  </p>

                  {missed.length === 0
                    ? <p className="ok">Every configuration found this one.</p>
                    : (
                      <>
                        <h4>Missed by {missed.length} configuration{missed.length === 1 ? '' : 's'}</h4>
                        {missed.map(({ result, outcome }) => (
                          <div key={configLabel(result)} className="miss">
                            <div className="miss-config">{configLabel(result)}</div>
                            <ol className="miss-retrieved">
                              {outcome!.retrieved.map((excerpt, i) => (
                                <li key={`${outcome!.questionId}-${i}`}>
                                  <span className="rank">{i + 1}</span> {excerpt}
                                </li>
                              ))}
                              {outcome!.retrieved.length === 0 && <li className="dim">nothing</li>}
                            </ol>
                          </div>
                        ))}
                      </>
                    )}

                  <h4>Rank of the first hit</h4>
                  <ul className="rank-list">
                    {perConfig.map(({ result, outcome }) => (
                      <li key={`rank-${configLabel(result)}`}>
                        <span className="dim">{configLabel(result)}</span>
                        <strong>
                          {outcome && outcome.rr > 0 ? `#${Math.round(1 / outcome.rr)}` : 'missed'}
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
