/**
 * The one thing every app in this origin has in common.
 *
 * Six apps with six accents and a reviewer who arrived from a deep link and may
 * not know whose work they are looking at. This is the attribution, and it is
 * deliberately the only shared chrome — anything more would flatten identities
 * the apps earned.
 *
 * Reads the theme's tokens but does not require them: every custom property
 * below carries a literal fallback, so the byline is still legible if it is
 * ever mounted somewhere theme.css was not loaded.
 *
 * Zero dependencies beyond React, and no import from `@labs/platform`. PlaneMode
 * ships this too, and its whole claim is that no server is involved; pulling a
 * Supabase client into its bundle through a footer would be a quiet lie.
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
  padding: .4rem .8rem;
  font: 400 .75rem/1.4 var(--font-body, ui-sans-serif, system-ui, sans-serif);
  letter-spacing: .01em;
  color: var(--silver, #a0a4a8);
  background: rgba(13, 27, 42, .55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-start-start-radius: .75rem;
  border-block-start: 1px solid var(--accent-border, rgba(255, 255, 255, .1));
  border-inline-start: 1px solid var(--accent-border, rgba(255, 255, 255, .1));
  opacity: .62;
  transform: translateY(0);
  transition: opacity .24s cubic-bezier(.4,0,.2,1), border-color .8s ease;
}
.labs-byline:hover,
.labs-byline:focus-within { opacity: 1; }

.labs-byline a {
  color: inherit;
  text-decoration: none;
  border-block-end: 1px solid transparent;
  padding-block-end: 1px;
  transition: color .18s cubic-bezier(.4,0,.2,1), border-color .18s cubic-bezier(.4,0,.2,1);
}
.labs-byline a:hover,
.labs-byline a:focus-visible {
  color: #fff;
  border-block-end-color: var(--accent, currentColor);
}
.labs-byline__name { font-weight: 550; color: var(--white, #e8edf2); }
.labs-byline__sep { opacity: .4; }

/* Out of the way where a fixed pill costs the most room. */
@media (max-width: 34rem) {
  .labs-byline { font-size: .6875rem; padding: .3rem .55rem; gap: .45rem; }
  .labs-byline__hide-sm { display: none; }
}
@media print { .labs-byline { display: none; } }
@media (prefers-reduced-motion: reduce) { .labs-byline { transition: none; } }
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
