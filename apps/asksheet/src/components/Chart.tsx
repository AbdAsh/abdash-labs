import { useEffect, useRef, useState } from 'react'
import { toChartSpec } from '../lib/chart'
import type { QueryResult } from '../lib/types'

/**
 * Renders a model-authored Vega-Lite spec.
 *
 * Vega is by far the heaviest thing in the bundle and most answers are tables,
 * so it is imported dynamically the first time a chart actually appears. A spec
 * that fails to render is dropped silently — the answer's table is already there
 * and is the thing that carries the information.
 */
export function Chart({
  spec,
  result,
  title,
}: {
  spec: Record<string, unknown> | undefined
  result: QueryResult
  title: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const prepared = toChartSpec(spec, result)

  useEffect(() => {
    if (!prepared || !host.current) return
    let view: { finalize: () => void } | null = null
    let cancelled = false

    void (async () => {
      try {
        const { default: embed } = await import('vega-embed')
        if (cancelled || !host.current) return
        const rendered = await embed(host.current, prepared as never, {
          actions: false,
          renderer: 'canvas',
        })
        if (cancelled) rendered.view.finalize()
        else view = rendered.view
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      view?.finalize()
    }
    // The spec is derived from a single immutable answer, so identity is stable
    // for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  if (!prepared || failed) return null

  return (
    <div className="chart-host">
      <div ref={host} role="img" aria-label={`Chart: ${title}`} />
    </div>
  )
}
