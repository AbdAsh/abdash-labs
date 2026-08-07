/**
 * Rejects a `_redirects` file that Cloudflare would reject — before the deploy,
 * not after it.
 *
 * This exists because a deploy died on exactly one of these rules and the
 * feedback arrived from the remote API, after the build, six lines at a time.
 * The rules are not guessable: the most natural SPA fallback anyone would write,
 * `/app/* /app/index.html 200`, is rejected outright, and the reason (Cloudflare's
 * own html_handling would strip `/index.html` back off and re-trigger the rule)
 * is invisible from the file itself.
 *
 * The predicate is transcribed from workers-sdk
 * `packages/workers-shared/utils/configuration/parseRedirects.ts`. Keeping it
 * verbatim rather than paraphrased is deliberate — a "cleaner" version that
 * disagrees with upstream is worse than no check, because it green-lights a file
 * that then fails in CI.
 */

/** Upstream treats a target with a scheme or protocol-relative host as absolute. */
function urlHasHost(url) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) || url.startsWith('//')
}

const PERMITTED_STATUS_CODES = new Set([200, 301, 302, 303, 307, 308])

/**
 * @param {string} text  contents of a _redirects file
 * @param {string} htmlHandling  the `assets.html_handling` the file will deploy under
 * @returns {{lineNumber: number, line: string, message: string}[]} empty when valid
 */
export function checkRedirects(text, htmlHandling = 'auto-trailing-slash') {
  const problems = []
  const seen = new Set()

  text.split('\n').forEach((raw, i) => {
    const lineNumber = i + 1
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) return

    const tokens = line.replace(/\s+#.*$/, '').split(/\s+/)
    if (tokens.length < 2 || tokens.length > 3) {
      problems.push({ lineNumber, line, message: `Expected 2 or 3 tokens, got ${tokens.length}.` })
      return
    }

    const [from, to, rawStatus = '302'] = tokens
    const status = Number(rawStatus)

    if (isNaN(status) || !PERMITTED_STATUS_CODES.has(status)) {
      problems.push({ lineNumber, line, message: `Status must be one of 200, 301, 302, 303, 307, 308. Got ${rawStatus}.` })
      return
    }

    // The rule that broke the deploy. A `/*` source pointing at an index file is
    // rejected unconditionally; the `/` source form is rejected only when
    // html_handling is on to strip the suffix back off.
    const hasRelativePath = !urlHasHost(to)
    const toIsIndex = /\/index(\.html)?$/.test(to)
    const hasWildcardToIndex = from.endsWith('/*') && toIsIndex
    const hasRootToIndex = from.endsWith('/') && toIsIndex
    if (hasRelativePath && (hasWildcardToIndex || (hasRootToIndex && htmlHandling !== 'none'))) {
      problems.push({
        lineNumber,
        line,
        message:
          `Infinite loop: "${from}" -> "${to}". html_handling would strip the ` +
          `/index suffix and re-trigger this rule. Point it at the directory ` +
          `("${to.replace(/index(\.html)?$/, '')}") instead of the file inside it.`,
      })
      return
    }

    if (status === 200 && urlHasHost(to)) {
      problems.push({ lineNumber, line, message: `Proxy (200) rules must point at a relative path. Got ${to}.` })
      return
    }

    if (seen.has(from)) {
      problems.push({ lineNumber, line, message: `Duplicate rule for ${from}; it would be silently ignored.` })
      return
    }
    seen.add(from)
  })

  return problems
}

/**
 * Reads `assets.html_handling` out of wrangler.jsonc.
 *
 * Comment-stripping is line-based rather than a full JSONC parse: the only thing
 * needed is one string value, and a naive `//` strip would eat the `https://` in
 * any comment that cites a doc URL.
 */
export function htmlHandlingFrom(wranglerSource) {
  const withoutComments = wranglerSource
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  return withoutComments.match(/"html_handling"\s*:\s*"([^"]+)"/)?.[1] ?? 'auto-trailing-slash'
}
