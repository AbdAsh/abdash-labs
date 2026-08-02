/** SHA-256 of the file's bytes, hex encoded. Content-addressed, so the same
 *  document uploaded under a different filename is still recognised. */
export async function contentHash(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
