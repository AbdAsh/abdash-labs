import { useEffect, useId, useRef } from 'react'
import type { Citation } from '../lib/chat'

/**
 * Citations as a collapsible footnote apparatus. Controlled by the parent Turn
 * so an inline [n] reference in the answer can open it and highlight source n.
 *
 * Each entry names its document as well as its page: retrieval now spans every
 * document in the notebook, so "p. 7" on its own no longer identifies anything.
 */
export function Citations({
  items,
  open,
  onToggle,
  highlight,
}: {
  items: Citation[]
  open: boolean
  onToggle: () => void
  highlight: number | null
}) {
  const regionId = useId()
  const listRef = useRef<HTMLOListElement>(null)

  // When a [n] reference opens+targets a source, bring it into view.
  useEffect(() => {
    if (!open || highlight == null || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-n="${highlight}"]`)
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const t = setTimeout(
      () => el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' }),
      reduce ? 0 : 200, // let the expand animation settle first
    )
    return () => clearTimeout(t)
  }, [open, highlight])

  if (items.length === 0) return null

  return (
    <aside className="citations" data-open={open}>
      <button
        type="button"
        className="citations__toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={onToggle}
      >
        <svg
          className="citations__caret"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <path
            d="M3 1.5 L7 5 L3 8.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="citations__label">Sources</span>
        <span className="citations__count">{items.length}</span>
      </button>

      <div className="citations__region" id={regionId} role="region" aria-label="Cited passages">
        <div className="citations__inner">
          <ol className="citations__list" ref={listRef}>
            {items.map((c) => (
              <li key={c.n} data-n={c.n} data-highlight={highlight === c.n || undefined}>
                <span className="cite-source">
                  <span className="cite-doc" dir="auto">
                    {c.document}
                  </span>
                  <span className="cite-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="cite-page">p. {c.page ?? '—'}</span>
                </span>
                <p dir="auto">{c.content}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </aside>
  )
}
