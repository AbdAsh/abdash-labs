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
const LABS = 'https://abdash.net/?tab=ai'

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

  /* Opaque, not tinted glass. This is a fixed element sitting on top of
     scrolling content, and at 55% the page text underneath read straight
     through it — two overlapping sentences competing in the same 20 pixels.
     A backdrop-filter does not save it either: blurring text you can still see
     is not the same as not seeing it. So: solid.

     The colour is --darker rather than the panel tint, so the strip reads as
     part of the page furniture rather than a floating card. */
  background: #0a1421;
  border-start-start-radius: .75rem;
  border-block-start: 1px solid var(--accent-border, rgba(255, 255, 255, .1));
  border-inline-start: 1px solid var(--accent-border, rgba(255, 255, 255, .1));
  box-shadow: -6px -6px 20px rgba(7, 15, 24, .55);

  /* Dimmed rather than transparent — the text stays fully opaque against its
     own solid background, so nothing shows through at rest. */
  color-scheme: dark;
  transition: color .24s cubic-bezier(.4,0,.2,1), border-color .8s ease;
}
.labs-byline:hover,
.labs-byline:focus-within { color: var(--white, #e8edf2); }

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
  /** Present when the byline is inside an app, which changes what the exit says. */
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
        {/* Inside an app this is a way out, so it says where it goes. It points
            straight at the AI tab rather than at labs.abdash.net, which now only
            redirects there — no reason to make the visitor take two hops. */}
        <a href={LABS}>{app ? 'Back to labs' : 'abdash labs'}</a>
      </footer>
    </>
  )
}
