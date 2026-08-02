/** Reads a required variable. Throws naming the variable, so a misconfigured
 *  deploy fails loudly at startup instead of producing `undefined` downstream. */
export function requireEnv(name: string, source: Record<string, unknown>): string {
  const value = source[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
