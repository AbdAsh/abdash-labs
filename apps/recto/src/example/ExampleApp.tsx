import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Spread } from '../components/Spread'
import { Verso, type UploadState } from '../components/Verso'
import { Recto } from '../components/Recto'
import { notebookIsRtl } from '../lib/documents'
import { exampleRun, capturedOn } from './run'

/**
 * The finished example: what Recto looks like once someone has done the work.
 *
 * It is the live product's own `Spread`, `Verso`, `Recto`, `Turn` and
 * `Citations`, given a saved run instead of a database. That reuse is the point
 * — a hand-built replica of the interface would drift away from the real one
 * within a month, and the first thing a reviewer would learn from it is that the
 * screenshot was a lie. Citations expand and `[n]` still scrolls to its source,
 * because that is `Turn`'s own behaviour and nothing here overrides it.
 *
 * Nothing on this page touches the network. There is no session, no anonymous
 * account, no captcha, no quota consumed — which is why it can be the default
 * for a visitor who has sixty seconds and no PDF to hand.
 */

const IDLE: UploadState = { status: 'idle', done: 0, total: 0, message: '' }

/** The mutating half of `Verso`'s contract. Every control that would reach one
 *  of these is withdrawn while `exhibit` is set, so they are unreachable rather
 *  than merely inert — there is no dead × or greyed button to click. */
const inert = () => {}

/** `public/example/` is served from the app's own base path, so this resolves
 *  under `/recto/` in production and `/` in a preview build. */
const sourceHref = (name: string) => `${import.meta.env.BASE_URL}example/${encodeURIComponent(name)}`

/**
 * Publishes the banner's real height as `--band` on the frame.
 *
 * At narrow widths the sources drawer and its toggle are fixed to the viewport,
 * so they have to be told where the banner ends or they open straight across it.
 * A constant would be right at desktop width and wrong on a phone, where the
 * same sentence wraps to three lines.
 */
function useBandHeight(
  frame: RefObject<HTMLDivElement | null>,
  band: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const host = frame.current
    const el = band.current
    if (!host || !el || typeof ResizeObserver === 'undefined') return
    const apply = () => host.style.setProperty('--band', `${el.offsetHeight}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [frame, band])
}

export function ExampleApp({ onLeave }: { onLeave: () => void }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const band = useRef<HTMLElement>(null)
  useBandHeight(frame, band)

  const run = exampleRun
  const captured = capturedOn(run.capturedAt)

  const notebook = {
    id: run.notebook.id,
    title: run.notebook.title,
    createdAt: run.notebook.createdAt,
    documentCount: run.documents.length,
  }

  // Exactly as the live app decides it: any right-to-left document mirrors the
  // whole spread. Both of these are English, so this is 'ltr' — but it is
  // computed rather than hard-coded, so a future example in Arabic just works.
  const dir = notebookIsRtl(run.documents) ? 'rtl' : 'ltr'

  return (
    <div className="exhibit-frame" ref={frame}>
      <header className="exhibit" role="note" ref={band}>
        <p className="exhibit__lead">
          <strong>This is a recording.</strong> A real run against the live Recto, captured on{' '}
          <time dateTime={run.capturedAt}>{captured}</time>. Nothing on this page is being generated
          now, and no answer here was written by hand.
        </p>
        <button type="button" className="exhibit__leave" onClick={onLeave}>
          Try it yourself
        </button>
      </header>

      <Spread
        dir={dir}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
        verso={
          <Verso
            loading={false}
            notebooks={[notebook]}
            activeId={notebook.id}
            limits={run.tier}
            totalDocuments={run.documents.length}
            documents={run.documents}
            documentsLoading={false}
            upload={IDLE}
            error={null}
            onDismissError={inert}
            onSelectNotebook={inert}
            onCreateNotebook={inert}
            onRenameNotebook={inert}
            onDeleteNotebook={inert}
            onUpload={inert}
            onDeleteDocument={inert}
            exhibit={
              <>
                <p>
                  <strong>These documents are invented.</strong> {run.fiction.statement}
                </p>
                <p>
                  Both were built as PDFs by the same script that captured this run, so they can be
                  downloaded and put through the real thing:
                </p>
                <ul className="exhibit-note__files">
                  {run.documents.map((d) => (
                    <li key={d.id}>
                      <a className="link" href={sourceHref(d.name)} download>
                        {d.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            }
          />
        }
        recto={
          <Recto
            loading={false}
            hasNotebook
            notebookTitle={run.notebook.title}
            readyCount={run.documents.length}
            unfinishedCount={0}
            conversations={[run.conversation]}
            conversationId={run.conversation.id}
            turns={run.turns}
            busy={false}
            error={null}
            messagesLeft={null}
            onDismissError={inert}
            onAsk={inert}
            onSelectConversation={inert}
            onDeleteConversation={inert}
            exhibit={
              <div className="exhibit-dock">
                <p className="exhibit-dock__label">
                  Saved conversation — asked and answered on{' '}
                  <time dateTime={run.capturedAt}>{captured}</time>, not just now.
                </p>
                <button type="button" className="exhibit-dock__cta" onClick={onLeave}>
                  Ask your own documents
                </button>
              </div>
            }
          />
        }
      />

      <footer className="colophon" dir={dir}>
        <p>
          Captured by <code>apps/recto/scripts/generate-example.mjs</code> against the deployed{' '}
          <code>recto-ingest</code> and <code>recto-chat</code>. Passages embedded with{' '}
          {run.models.embedding}; answers written by {run.models.answer}. Free tier:{' '}
          {run.tier.notebooks} notebook, {run.tier.documents} documents, {run.tier.messages}{' '}
          messages a day.{' '}
          <button type="button" className="link" onClick={onLeave}>
            Leave the example
          </button>
        </p>
      </footer>
    </div>
  )
}
