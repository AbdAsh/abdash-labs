/**
 * Which of the two paths the visitor is on.
 *
 * `example` is the default, and it has to be: it renders instantly from a
 * committed fixture, needs no session, calls nothing and costs nothing. The
 * live product asks for a captcha and an anonymous account before it can show a
 * single thing, which is a poor trade for someone who is going to spend a minute
 * here.
 */
export type Mode = 'example' | 'live'

/** The query parameter, so a chosen mode is linkable. */
export const MODE_PARAM = 'mode'

/** The stored key. It is namespaced because every app on this origin shares one
 *  localStorage — the same reason they share one Supabase session. */
export const MODE_KEY = 'recto:mode'

function isMode(value: unknown): value is Mode {
  return value === 'example' || value === 'live'
}

/**
 * The URL wins, then what the visitor last chose, then the example.
 *
 * The stored value is what makes the OAuth round trip survivable: linking GitHub
 * sends the browser to the provider and back to `origin + pathname`, dropping
 * the query string on the way. Without the fallback, someone who signed in from
 * the live app would land back on the recording.
 */
export function modeFrom(search: string, stored: string | null): Mode {
  const asked = new URLSearchParams(search).get(MODE_PARAM)
  if (isMode(asked)) return asked
  if (isMode(stored)) return stored
  return 'example'
}

/** Storage can throw outright — Safari in private browsing, an embedded frame
 *  with third-party storage blocked — and a mode preference is never worth
 *  taking the page down for. */
export function readStoredMode(): string | null {
  try {
    return window.localStorage.getItem(MODE_KEY)
  } catch {
    return null
  }
}

export function initialMode(): Mode {
  return modeFrom(window.location.search, readStoredMode())
}

/**
 * Records the choice in both places it has to survive: storage, for the OAuth
 * redirect, and the URL, so the address bar does not describe a page that is no
 * longer on screen.
 */
export function rememberMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* see readStoredMode */
  }
  try {
    const url = new URL(window.location.href)
    url.searchParams.set(MODE_PARAM, mode)
    window.history.replaceState(null, '', url)
  } catch {
    /* replaceState is refused on some sandboxed origins; the mode still holds */
  }
}
