/**
 * The strip across the top of every page on labs.abdash.net.
 *
 * These are live demos on a real account with real spend caps, changing while
 * people look at them. Saying so up front is not a disclaimer — it sets the
 * expectation that something might be mid-change, which is a different and much
 * better first impression than someone hitting a rough edge and concluding the
 * work is sloppy.
 *
 * In normal flow and `sticky`, deliberately not `fixed`. A fixed bar overlaps
 * whatever is beneath it, and this origin has layouts that fill the viewport —
 * they would be pushed under it and lose their last 32 pixels. Sticky occupies
 * real space, so everything below simply starts lower, and the layouts that
 * measure themselves against the viewport subtract `--labs-banner-h`.
 *
 * Zero dependencies beyond React. PlaneMode renders this too.
 */
import { useId } from 'react'

const SOURCE = 'https://github.com/AbdAsh/abdash-labs'

const CSS = `
.labs-devbar {
  position: sticky;
  inset-block-start: 0;
  z-index: 2147482000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  flex-wrap: wrap;
  block-size: var(--labs-banner-h, 32px);
  padding-inline: .75rem;
  font: 500 .72rem/1 var(--font-body, ui-sans-serif, system-ui, sans-serif);
  letter-spacing: .01em;
  color: var(--silver, #a0a4a8);
  background: #0a1421;
  border-block-end: 1px solid var(--accent-border, rgba(255, 255, 255, .12));
}

.labs-devbar__dot {
  inline-size: 6px;
  block-size: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--accent, #2ec4b6);
  animation: labs-devbar-pulse 2s ease-in-out infinite;
}
@keyframes labs-devbar-pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }

.labs-devbar__label {
  color: var(--accent, #2ec4b6);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .08em;
  font-size: .66rem;
}

.labs-devbar a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.labs-devbar a:hover { color: var(--white, #e8edf2); }

/* The sentence is the first thing to go — the label and the pulse already say
   the important part, and a wrapped two-line bar on a phone costs more than it
   returns. */
@media (max-width: 40rem) {
  .labs-devbar__long { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .labs-devbar__dot { animation: none; opacity: 1; }
}
@media print { .labs-devbar { display: none; } }
`

export function DevBanner() {
  const id = useId()
  return (
    <>
      <style id={`labs-devbar-${id}`}>{CSS}</style>
      <div className="labs-devbar" role="status">
        <span className="labs-devbar__dot" aria-hidden="true" />
        <span className="labs-devbar__label">In development</span>
        <span className="labs-devbar__long">
          Live demos, actively being built — things may change or briefly break.{' '}
          <a href={SOURCE} rel="noreferrer">
            Source
          </a>
        </span>
      </div>
    </>
  )
}
