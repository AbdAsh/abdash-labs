import { useEffect, useRef, useState } from 'react'
import { CHUNKERS } from '../lib/chunkers'
import type { ConfigResult } from '../lib/engine'

/**
 * MRR against chunk size, grouped by chunking strategy.
 *
 * This is the one chart worth drawing: chunk size is the parameter practitioners
 * pick by folklore, and the curve for each strategy is exactly the thing folklore
 * cannot tell them. Vega-Lite is loaded on demand — it is a large dependency and
 * nobody needs it before a run finishes.
 */
export function MetricChart({ results }: { results: ConfigResult[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!ref.current || results.length === 0) return
    let cancelled = false
    const container = ref.current

    const values = results.map((r) => ({
      size: r.config.size,
      mrr: Number(r.mrr.toFixed(4)),
      hitRate: Number(r.hitRate.toFixed(4)),
      strategy: CHUNKERS.find((c) => c.id === r.config.chunker)?.label ?? r.config.chunker,
      overlap: r.config.overlap,
      model: r.config.model,
    }))

    void (async () => {
      try {
        const { default: embed } = await import('vega-embed')
        if (cancelled) return
        await embed(container, {
          $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
          description: 'Mean reciprocal rank against chunk size, grouped by chunking strategy',
          data: { values },
          width: 'container',
          height: 260,
          background: 'transparent',
          mark: { type: 'line', point: true, strokeWidth: 2 },
          encoding: {
            x: {
              field: 'size',
              type: 'quantitative',
              title: 'Chunk size (characters)',
              scale: { zero: false, nice: true },
            },
            y: { field: 'mrr', type: 'quantitative', title: 'MRR', scale: { domain: [0, 1] } },
            color: { field: 'strategy', type: 'nominal', title: 'Strategy' },
            strokeDash: { field: 'model', type: 'nominal', title: 'Model' },
            tooltip: [
              { field: 'strategy', title: 'Strategy' },
              { field: 'size', title: 'Size' },
              { field: 'overlap', title: 'Overlap' },
              { field: 'model', title: 'Model' },
              { field: 'mrr', title: 'MRR' },
              { field: 'hitRate', title: 'Hit rate', format: '.0%' },
            ],
          },
          config: {
            axis: { labelColor: '#9aa4b2', titleColor: '#c8d0dc', gridColor: '#232a35' },
            legend: { labelColor: '#9aa4b2', titleColor: '#c8d0dc' },
            view: { stroke: 'transparent' },
          },
        }, { actions: false, renderer: 'canvas' })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => { cancelled = true }
  }, [results])

  if (results.length === 0) return null

  return (
    <section className="panel">
      <h2>MRR by chunk size</h2>
      {failed
        ? <p className="warn">The chart could not load. The table above has the same numbers.</p>
        : <div className="chart" ref={ref} />}
    </section>
  )
}
