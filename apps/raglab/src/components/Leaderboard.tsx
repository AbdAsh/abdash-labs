import { configLabel, type ConfigResult } from '../lib/engine'

const pct = (n: number) => `${Math.round(n * 100)}%`
const three = (n: number) => n.toFixed(3)

/**
 * Ranked configurations.
 *
 * Sorted by MRR rather than hit rate: hit rate saturates — several configs reach
 * 100% on a small question set and the table stops discriminating — while MRR
 * keeps separating them by *where* in the ranking the answer landed, which is
 * what a reader actually experiences.
 */
export function Leaderboard({ results }: { results: ConfigResult[] }) {
  if (results.length === 0) return null

  const ranked = [...results].sort((a, b) => (b.mrr - a.mrr) || (b.hitRate - a.hitRate))
  const winner = ranked[0]!
  const baseline = ranked[ranked.length - 1]!

  /**
   * Configurations that produced the identical measurement.
   *
   * Different settings can chunk a document exactly the same way — overlap does
   * nothing when every paragraph already fits in one chunk, and `recursive`
   * matches `sentence-window` on text with no paragraph breaks. The rows then
   * tie perfectly and read as a meaningful dead heat between two strategies when
   * they were never two strategies on this document. Saying so is a real finding
   * about the document, not a caveat.
   */
  const twinOf = new Map<string, string>()
  const seen = new Map<string, string>()
  for (const r of ranked) {
    const identity = JSON.stringify(r.perQuestion)
    const first = seen.get(identity)
    if (first) twinOf.set(configLabel(r.config), first)
    else seen.set(identity, configLabel(r.config))
  }

  return (
    <section className="panel">
      <h2>Leaderboard</h2>
      <p className="lede">
        Ranked by MRR. Hit rate saturates on a short question set; mean reciprocal
        rank keeps separating configurations by where the answer actually landed.
      </p>

      <div className="verdict">
        <strong>{configLabel(winner.config)}</strong> wins at MRR {three(winner.mrr)}
        {ranked.length > 1 && (
          <> — {three(winner.mrr - baseline.mrr)} above the weakest configuration tried.</>
        )}
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Configuration</th>
              <th scope="col" className="num">Hit@k</th>
              <th scope="col" className="num">MRR</th>
              <th scope="col" className="num">Chunks</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => {
              const label = configLabel(r.config)
              const twin = twinOf.get(label)
              return (
                <tr key={label} className={i === 0 ? 'winner' : ''}>
                  <td className="num">{i + 1}</td>
                  <td>
                    {label}
                    {twin && (
                      <span className="twin">
                        identical chunking to {twin} — these settings made no difference
                        to this document
                      </span>
                    )}
                  </td>
                  <td className="num">{pct(r.hitRate)}</td>
                  <td className="num">
                    <span className="bar" style={{ '--w': `${r.mrr * 100}%` } as React.CSSProperties}>
                      {three(r.mrr)}
                    </span>
                  </td>
                  <td className="num">{r.chunkCount}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
