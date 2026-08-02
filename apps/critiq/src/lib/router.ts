/**
 * A router in thirty lines.
 *
 * Critiq has exactly two routes, so pulling in a routing library would add a
 * dependency and a bundle for a `switch`. The one thing that genuinely matters
 * is the base prefix: every lab app is served from a path on one origin, so a
 * router that assumes it owns `/` will capture another app's URLs.
 */
export const BASE = '/critiq'

export type Route =
  | { name: 'submit' }
  | { name: 'report'; slug: string }

export function parseRoute(pathname: string): Route {
  const withoutBase = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname
  const segments = withoutBase.split('/').filter((s) => s !== '')

  if (segments[0] === 'r' && segments[1]) {
    return { name: 'report', slug: safeDecode(segments[1]) }
  }
  return { name: 'submit' }
}

export function submitPath(): string {
  return `${BASE}/`
}

export function reportPath(slug: string): string {
  return `${BASE}/r/${encodeURIComponent(slug)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
