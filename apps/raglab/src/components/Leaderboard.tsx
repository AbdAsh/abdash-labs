import { CHUNKERS } from '../lib/chunkers'
import { EMBEDDING_MODELS, type ConfigResult } from '../lib/engine'

const pct = (n: number) => `${Math.round(n * 100)}%`
const three = (n: number) => n.toFixed(3)

export function configLabel(r: ConfigResult): string {
  const chunker = CHUNKERS.find((c) => c.id === r.config.chunker)?.label ?? r.config.chunker
  const model = EMBEDDING_MODELS[r.config.model]?.label ?? r.config.model
  return `${chunker} · ${r.config.size}/${r.config.overlap} · ${model} · k=${r.config.k}`
}

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

  return (
    <section className="panel">
      <h2>Leaderboard</h2>
      <p className="lede">
        Ranked by MRR. Hit rate saturates on a short question set; mean reciprocal
        rank keeps separating configurations by where the answer actually landed.
      </p>

      <div className="verdict">
        <strong>{configLabel(winner)}</strong> wins at MRR {three(winner.mrr)}
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
            {ranked.map((r, i) => (
              <tr key={configLabel(r)} className={i === 0 ? 'winner' : ''}>
                <td className="num">{i + 1}</td>
                <td>{configLabel(r)}</td>
                <td className="num">{pct(r.hitRate)}</td>
                <td className="num">
                  <span className="bar" style={{ '--w': `${r.mrr * 100}%` } as React.CSSProperties}>
                    {three(r.mrr)}
                  </span>
                </td>
                <td className="num">{r.chunkCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
