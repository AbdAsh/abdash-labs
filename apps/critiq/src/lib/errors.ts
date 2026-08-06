/**
 * Turning a failure into something the reader can do next.
 *
 * The Edge Function fails in six genuinely different ways, and every one of
 * them used to reach the page as one red line of server prose. "Refusing to
 * fetch this URL: 10.0.0.5 is a private or reserved address" is accurate and
 * tells a person nothing about what to try instead; a 429 and a 502 are the
 * same colour and the same shape, though one is solved by waiting a day and the
 * other by pressing the button again.
 *
 * This maps a status and a message to a title, an explanation and — the part
 * that matters — the one action worth offering.
 */

export type ErrorAction = 'retry' | 'link-github' | 'none'

export interface DescribedError {
  title: string
  detail: string
  action: ErrorAction
  /** The server's own words, kept so nothing is hidden behind our paraphrase. */
  raw: string
}

export interface RawError {
  status?: number | null
  message?: string | null
}

export function describeError(error: RawError | null | undefined): DescribedError {
  const raw = (error?.message ?? '').trim()
  const status = typeof error?.status === 'number' ? error.status : null
  const lower = raw.toLowerCase()

  if (status === 429 || lower.includes('daily limit')) {
    return {
      title: "That's your reviews for today",
      detail:
        'The daily limit exists because every run fetches a live page and calls a model. It resets ' +
        'at midnight UTC. Linking a GitHub account raises the limit from 1 review a day to 3, and ' +
        'reports you have already run stay yours.',
      action: 'link-github',
      raw,
    }
  }

  if (status === 415 || lower.startsWith('critiq reviews web pages')) {
    return {
      title: 'That URL is not a web page',
      detail:
        'Critiq reads HTML: the markup, the metadata and the structured data. A PDF, an image or a ' +
        'JSON endpoint has none of those, so there is nothing to review. Try the page that links ' +
        'to the file.',
      action: 'none',
      raw,
    }
  }

  if (lower.startsWith('refusing to fetch this url')) {
    return {
      title: 'That address cannot be reviewed from here',
      detail:
        'Critiq fetches the URL from a server, not from your browser, so it only reaches the public ' +
        'internet — never localhost, a private network, or a cloud metadata address. Anything ' +
        'behind a login or a VPN is unreachable for the same reason.',
      action: 'none',
      raw,
    }
  }

  if (status === 401 || lower.includes('invalid session') || lower.includes('authorization')) {
    return {
      title: 'Your session expired',
      detail: 'Reload the page to start a new one. Nothing you have already run is lost.',
      action: 'retry',
      raw,
    }
  }

  if (isTimeout(lower)) {
    return {
      title: 'The page took too long to answer',
      detail:
        'Critiq waits 15 seconds for a response. A page slower than that is worth looking at for ' +
        'its own sake — but it may also just have been a bad moment, so it is worth one retry.',
      action: 'retry',
      raw,
    }
  }

  if (isNetwork(lower) || (status !== null && status >= 500)) {
    return {
      title: 'The review could not be completed',
      detail:
        'Either the page did not respond or something on our side failed. Nothing was saved. Trying ' +
        'again is safe.',
      action: 'retry',
      raw,
    }
  }

  if (status === 400) {
    return {
      title: 'That URL could not be used',
      detail: raw || 'Check the address and try again.',
      action: 'none',
      raw,
    }
  }

  return {
    title: 'Something went wrong',
    detail: raw || 'No further detail was returned.',
    action: 'retry',
    raw,
  }
}

function isTimeout(lower: string): boolean {
  return lower.includes('timed out') || lower.includes('timeout') || lower.includes('aborted')
}

function isNetwork(lower: string): boolean {
  return lower.includes('failed to fetch') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('load failed')
}
