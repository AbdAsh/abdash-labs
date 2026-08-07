import { type ReactNode, useEffect } from 'react'
import {
  EXAMPLES,
  type ExampleReport,
  exampleLabel,
  exampleMarkdownNote,
  findExample,
} from '../example'
import { displayUrl } from '../lib/format'
import { ReportView } from '../components/ReportView'
import { examplePath, submitPath } from '../lib/router'

/**
 * A finished report, instantly, for free.
 *
 * The problem this solves is not that Critiq is slow — fifteen seconds for a
 * fetch, a parse, twenty-three checks and a model call is fine. The problem is
 * that fifteen seconds and one of an anonymous visitor's one daily reviews is
 * an absurd price to pay for the question "what does this produce?", and
 * someone evaluating the tool asks that question before any other. So the
 * finished output is one click away and costs nothing.
 *
 * It renders through `ReportView`, the same component the live route uses, so
 * what a reviewer reads here is what they get when they run one. The one thing
 * this route adds is the thing it must add: a label, on the report itself, that
 * cannot be dismissed and says whose page this is and when it was reviewed.
 */
export function Example(
  { id, navigate }: { id: string | null; navigate: (path: string) => void },
) {
  const example = findExample(id)

  // Unknown id → the default example rather than a 404. `/critiq/example` is a
  // link that gets pasted into applications and messages; a renamed fixture
  // must degrade to showing something real, not to an error page.
  useEffect(() => {
    if (!example && EXAMPLES.length > 0) navigate(examplePath())
  }, [example, navigate])

  useEffect(() => {
    if (!example) return
    const previous = document.title
    document.title = `Critiq — example review of ${displayUrl(example.url, 40)}`
    return () => {
      document.title = previous
    }
  }, [example])

  // Same reasoning as the report route: these are reviews of real sites, and
  // Critiq is not a name-and-shame surface. The landing page stays indexable.
  useEffect(() => {
    const tag = document.createElement('meta')
    tag.name = 'robots'
    tag.content = 'noindex, nofollow'
    document.head.appendChild(tag)
    return () => tag.remove()
  }, [])

  if (!example) {
    return (
      <div className="panel">
        <h1 className="title">No example here</h1>
        <p className="lede">This build ships no saved examples.</p>
        <p className="meta">
          <Link to={submitPath()} navigate={navigate}>Review a URL instead</Link>
        </p>
      </div>
    )
  }

  return (
    <div className="stack">
      <section className="panel">
        <h1 className="title">A finished Critiq report</h1>
        <p className="lede">
          Real output, saved. Nothing is fetched, nothing is graded and no quota is spent when you
          open this — a review takes about fifteen seconds and one of your reviews for the day, and
          that is a silly price for finding out what the thing produces.
        </p>

        {EXAMPLES.length > 1 && (
          <div className="examples" role="group" aria-label="Choose an example">
            {EXAMPLES.map((option) => (
              <a
                key={option.id}
                className={`examples__tab${option.id === example.id ? ' is-active' : ''}`}
                aria-current={option.id === example.id ? 'true' : undefined}
                href={examplePath(option.id)}
                onClick={(e) => {
                  e.preventDefault()
                  navigate(examplePath(option.id))
                }}
              >
                <span className="examples__title">{option.title}</span>
                <span className="examples__url">{displayUrl(option.url, 34)}</span>
              </a>
            ))}
          </div>
        )}

        <p className="lede examples__blurb">{example.blurb}</p>

        <p className="meta">
          <Link to={submitPath()} navigate={navigate}>Review a URL of your own →</Link>
        </p>
      </section>

      <ReportView
        report={example.report}
        copyLink={exampleUrl(example)}
        markdownNote={exampleMarkdownNote(example)}
        banner={<ExampleStamp example={example} />}
      />

      <p className="meta">
        <Link to={submitPath()} navigate={navigate}>Review a URL of your own</Link>
      </p>
    </div>
  )
}

/**
 * The label, and the reason this route is allowed to exist.
 *
 * Sits above the grade, inside the report card, undismissable, naming the URL
 * and the date. A reader who mistakes a saved report for one they triggered has
 * been misled about what the tool did for them, and no amount of accuracy
 * further down the page repairs that.
 */
function ExampleStamp({ example }: { example: ExampleReport }) {
  return (
    <p className="stamp">
      <span className="stamp__tag">Saved example</span>
      <span>
        {exampleLabel(example).replace(/^Saved example — /, '')} Captured with{' '}
        <code>apps/critiq/scripts/capture-example.mjs</code> from the deployed function; report{' '}
        <code>{example.slug}</code>.
      </span>
    </p>
  )
}

function exampleUrl(example: ExampleReport): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return `${origin}${examplePath(example.id)}`
}

function Link(
  { to, navigate, children }: {
    to: string
    navigate: (path: string) => void
    children: ReactNode
  },
) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
