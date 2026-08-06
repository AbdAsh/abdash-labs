/**
 * The one-line `unknown → string` narrowing every catch site in this app needs.
 *
 * Recto's own data layer normalises PostgREST's plain `{ message, details,
 * hint, code }` object into a real Error before it ever reaches a component,
 * so in practice this receives Errors. The `[object Object]` guard is the
 * backstop for everything that does not come from that layer — a future
 * platform helper, a library that throws a bare object — because the one thing
 * an error message may never be is the word "object" twice.
 */
export function say(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  const text = String(e)
  return text === '[object Object]' ? 'Something went wrong.' : text
}
