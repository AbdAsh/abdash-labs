import { headingOutline, measurements } from '../lib/digest'

/**
 * Everything Critiq actually observed.
 *
 * Folded away by default — it is reference, not the point of the page — but it
 * is the fastest way to catch the failure mode no finding can express: that the
 * review is of the wrong page. A cookie wall, a redirect to a regional
 * homepage, an error document served with a 200; all of them produce a report
 * that reads plausibly and describes something the reader never asked about.
 * One glance at the title and word count settles it.
 */
export function Measurements({ digest }: { digest: Record<string, unknown> | null }) {
  const groups = measurements(digest)
  const outline = headingOutline(digest)
  if (groups.length === 0) return null

  return (
    // Carries its own panel, so a digest with nothing in it renders nothing at
    // all rather than an empty box the reader has to wonder about.
    <details className="panel panel--quiet measures">
      <summary className="measures__summary">What Critiq read from the page</summary>

      <div className="measures__body">
        {groups.map((group) => (
          <section className="measures__group" key={group.title}>
            <h3 className="measures__title">{group.title}</h3>
            <dl className="measures__list">
              {group.rows.map((rowItem) => (
                <div className="measures__row" key={rowItem.label}>
                  <dt>{rowItem.label}</dt>
                  <dd className={rowItem.mono ? 'is-mono' : undefined}>{rowItem.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        {outline.length > 0 && (
          <section className="measures__group">
            <h3 className="measures__title">Heading outline</h3>
            <ol className="outline">
              {outline.map((heading, index) => (
                <li className={`outline__item outline__item--h${heading.level}`} key={index}>
                  <span className="outline__level">h{heading.level}</span>
                  <span>{heading.text}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </details>
  )
}
