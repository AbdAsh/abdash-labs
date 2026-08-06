import { useCallback, useMemo, useRef, useState } from 'react'
import type { Question } from '../lib/metrics'
import { MIN_QUESTIONS, readyToRun, suggestQuestions, validateGold } from '../lib/questions'

interface Props {
  text: string
  questions: Question[]
  onChange: (questions: Question[]) => void
}

function excerptAround(text: string, start: number, end: number, pad = 90) {
  const from = Math.max(0, start - pad)
  const to = Math.min(text.length, end + pad)
  return {
    before: `${from > 0 ? '…' : ''}${text.slice(from, start)}`,
    gold: text.slice(start, end),
    after: `${text.slice(end, to)}${to < text.length ? '…' : ''}`,
  }
}

/**
 * The labelling surface.
 *
 * Labelling is the actual bottleneck in retrieval evaluation, so this screen's
 * only job is to make the first fifteen labels cheap. Suggestions arrive as
 * *candidate passages* the user rewrites, confirms or deletes — never as finished
 * labels, because an unreviewed gold span produces a benchmark that is precise
 * and wrong.
 *
 * Spans are set by selecting text in the rendered document rather than by typing
 * offsets: a selection cannot be off by one, and a typed index silently can.
 */
export function QuestionBuilder({ text, questions, onChange }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const documentRef = useRef<HTMLPreElement>(null)

  const status = useMemo(() => readyToRun(text, questions), [text, questions])

  const suggest = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const suggested = await suggestQuestions(text, 10)
      const existing = new Set(questions.map((q) => `${q.gold.start}:${q.gold.end}`))
      onChange([
        ...questions,
        ...suggested.filter((q) => !existing.has(`${q.gold.start}:${q.gold.end}`)),
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [text, questions, onChange])

  /**
   * Re-anchors a question's gold span to the current text selection.
   *
   * Offsets come from the DOM selection relative to the whole document node, so
   * they land in the same coordinate system the chunkers use. Anything else and
   * the two drift apart invisibly.
   */
  const captureSelection = useCallback((id: string) => {
    const node = documentRef.current
    const selection = window.getSelection()
    if (!node || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setError('Select the passage in the document first, then press "Use selection".')
      return
    }
    const range = selection.getRangeAt(0)
    if (!node.contains(range.commonAncestorContainer)) {
      setError('That selection is outside the document.')
      return
    }
    const before = range.cloneRange()
    before.selectNodeContents(node)
    before.setEnd(range.startContainer, range.startOffset)
    const start = before.toString().length
    const end = start + range.toString().length

    const next = questions.map((q) => (q.id === id ? { ...q, gold: { start, end } } : q))
    if (!validateGold(text, next.find((q) => q.id === id)!)) {
      setError('That span is too short to be an answer. Select at least a full clause.')
      return
    }
    setError(null)
    onChange(next)
  }, [questions, text, onChange])

  const addBlank = () => {
    onChange([
      ...questions,
      { id: `q${Date.now().toString(36)}`, text: '', gold: { start: 0, end: 0 } },
    ])
  }

  return (
    <section className="panel">
      <h2>1b · Questions and gold spans</h2>
      <p className="lede">
        A gold answer is a character range in the document. A retrieved chunk hits
        when it covers at least half of that range — which is what makes scores
        comparable across chunkings that cut the text in completely different places.
      </p>

      <div className="toolbar">
        <button type="button" onClick={suggest} disabled={busy}>
          {busy ? 'Finding passages…' : 'Suggest 10 passages'}
        </button>
        <button type="button" className="secondary" onClick={addBlank}>Add blank</button>
        <span className={status.ok ? 'ok' : 'warn'}>
          {questions.filter((q) => validateGold(text, q)).length} valid ·{' '}
          {MIN_QUESTIONS} needed
        </span>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <ol className="questions">
        {questions.map((q) => {
          const valid = validateGold(text, q)
          const around = valid ? excerptAround(text, q.gold.start, q.gold.end) : null
          return (
            <li key={q.id} className={valid ? '' : 'invalid'}>
              <input
                type="text"
                value={q.text}
                placeholder="What does the document say about…?"
                aria-label="Question"
                onChange={(e) => onChange(
                  questions.map((x) => (x.id === q.id ? { ...x, text: e.target.value } : x)),
                )}
              />
              {around
                ? (
                  <p className="gold-preview">
                    <span className="dim">{around.before}</span>
                    <mark>{around.gold}</mark>
                    <span className="dim">{around.after}</span>
                  </p>
                )
                : <p className="gold-preview empty">No gold span yet.</p>}
              <div className="row-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => captureSelection(q.id)}
                >
                  Use selection
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => onChange(questions.filter((x) => x.id !== q.id))}
                >
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ol>

      <details className="document" open={questions.length > 0}>
        <summary>Document text — select a passage to set a gold span</summary>
        <pre ref={documentRef} className="document-text">{text}</pre>
      </details>

      {!status.ok && <p className="warn">{status.reason}</p>}
    </section>
  )
}
