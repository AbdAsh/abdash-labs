import { useEffect, useRef, useState } from 'react'

type State = 'idle' | 'copied' | 'failed'

/**
 * One copy affordance for the whole app.
 *
 * Reports it when the clipboard is refused rather than silently doing nothing:
 * a button that gives no feedback teaches people to press it twice and then
 * paste the wrong thing. `navigator.clipboard` is undefined on a page served
 * over plain http and blocked outright by some embedded browsers, so the
 * failure path is real rather than defensive decoration.
 */
export function CopyButton(
  { text, label = 'Copy', copiedLabel = 'Copied' }: {
    text: string
    label?: string
    copiedLabel?: string
  },
) {
  const [state, setState] = useState<State>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const copy = async () => {
    if (timer.current) clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  return (
    <button
      type="button"
      className={`button button--ghost${state === 'copied' ? ' is-copied' : ''}`}
      onClick={() => void copy()}
    >
      <span aria-hidden="true">
        {state === 'copied' ? copiedLabel : state === 'failed' ? 'Select and copy' : label}
      </span>
      <span className="visually-hidden" role="status">
        {state === 'copied'
          ? `${copiedLabel} to clipboard`
          : state === 'failed'
          ? 'Copying was blocked by the browser. Select the text and copy it manually.'
          : label}
      </span>
    </button>
  )
}
