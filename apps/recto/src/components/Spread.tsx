import type { ReactNode } from 'react'

/**
 * The open book. Sources on the verso, conversation on the recto, a real gutter
 * between them.
 *
 * `dir` on the container is the whole mirroring mechanism: grid columns are laid
 * out along the inline axis, so `dir="rtl"` puts the verso on the right without
 * a single duplicated rule. Every style in index.css is written with logical
 * properties for the same reason — there is no `left` or `right` anywhere.
 */
export function Spread({
  verso,
  recto,
  dir,
  drawerOpen,
  onToggleDrawer,
}: {
  verso: ReactNode
  recto: ReactNode
  dir: 'ltr' | 'rtl'
  drawerOpen: boolean
  onToggleDrawer: () => void
}) {
  return (
    <div className="spread" dir={dir} data-dir={dir} data-drawer={drawerOpen ? 'open' : 'closed'}>
      <button
        type="button"
        className="spread__drawer-toggle"
        aria-expanded={drawerOpen}
        aria-controls="verso"
        onClick={onToggleDrawer}
      >
        {drawerOpen ? 'Close sources' : 'Sources'}
      </button>

      <aside className="spread__verso" id="verso" aria-label="Sources">
        {verso}
      </aside>

      <div className="spread__gutter" aria-hidden="true" />

      <main className="spread__recto">{recto}</main>

      {/* Only interactive while the drawer is open at narrow widths. */}
      <button
        type="button"
        className="spread__scrim"
        tabIndex={drawerOpen ? 0 : -1}
        aria-label="Close sources"
        onClick={onToggleDrawer}
      />
    </div>
  )
}
