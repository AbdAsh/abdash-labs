/**
 * The one thing every app in this origin has in common.
 *
 * Six apps with six visual identities — a book spread, a dark offline console, a
 * report, a graph — and a reviewer who arrived from a link and may not know whose
 * work they are looking at. This is the attribution, and it is deliberately the
 * only shared chrome: anything more would flatten identities the apps earned.
 *
 * Zero dependencies beyond React, and no import from `@labs/platform`. PlaneMode
 * ships this too, and its whole claim is that no server is involved; pulling a
 * Supabase client into its bundle through a footer would be a quiet lie.
 *
 * Styles are scoped by a single class prefix and injected once, so an app can
 * mount it without adding a stylesheet import to its build.
 */
import { useId } from 'react'

const HOME = 'https://abdash.net'
const SOURCE = 'https://github.com/AbdAsh/abdash-labs'
const LABS = 'https://labs.abdash.net/'

const CSS = `
.labs-byline {
  position: fixed;
  inset-block-end: 0;
  inset-inline-end: 0;
  z-index: 2147483000;
  display: flex;
  gap: .625rem;
  align-items: center;
  margin: 0;
  padding: .4rem .7rem;
  font: 400 .75rem/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .01em;
  color: var(--labs-byline-fg, #6b7280);
  background: var(--labs-byline-bg, rgba(255, 255, 255, .82));
  border-start-start-radius: .5rem;
  border-block-start: 1px solid var(--labs-byline-line, rgba(0, 0, 0, .08));
  border-inline-start: 1px solid var(--labs-byline-line, rgba(0, 0, 0, .08));
  backdrop-filter: blur(8px);
  opacity: .72;
  transition: opacity .18s ease;
}
.labs-byline:hover,
.labs-byline:focus-within { opacity: 1; }

.labs-byline a {
  color: inherit;
  text-decoration: none;
  border-block-end: 1px solid currentColor;
  padding-block-end: 1px;
}
.labs-byline a:hover,
.labs-byline a:focus-visible { color: var(--labs-byline-accent, #111827); }
.labs-byline__name { font-weight: 550; }
.labs-byline__sep { opacity: .45; }

/* Out of the way where a fixed pill costs the most room. */
@media (max-width: 34rem) {
  .labs-byline { font-size: .6875rem; padding: .3rem .5rem; gap: .45rem; }
  .labs-byline__hide-sm { display: none; }
}
@media print { .labs-byline { display: none; } }
@media (prefers-reduced-motion: reduce) { .labs-byline { transition: none; } }

@media (prefers-color-scheme: dark) {
  .labs-byline {
    color: var(--labs-byline-fg, #9ca3af);
    background: var(--labs-byline-bg, rgba(17, 18, 22, .82));
    border-color: var(--labs-byline-line, rgba(255, 255, 255, .1));
  }
  .labs-byline a:hover,
  .labs-byline a:focus-visible { color: var(--labs-byline-accent, #f3f4f6); }
}
`

export interface BylineProps {
  /** This app's name, so "all seven demos" reads as a way out rather than a repeat. */
  app?: string
}

export function Byline({ app }: BylineProps) {
  const id = useId()
  return (
    <>
      <style id={`labs-byline-${id}`}>{CSS}</style>
      <footer className="labs-byline" aria-label="About this project">
        <span>
          Built by{' '}
          <a className="labs-byline__name" href={HOME}>
            Abdulrahman Mahmutoglu
          </a>
        </span>
        <span className="labs-byline__sep labs-byline__hide-sm" aria-hidden="true">
          ·
        </span>
        <a className="labs-byline__hide-sm" href={SOURCE} rel="noreferrer">
          Source
        </a>
        <span className="labs-byline__sep" aria-hidden="true">
          ·
        </span>
        <a href={LABS}>{app ? 'All seven demos' : 'abdash labs'}</a>
      </footer>
    </>
  )
}
