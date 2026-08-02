export interface Page {
  page: number
  text: string
}

export interface Chunk {
  content: string
  page: number
  index: number
}

export function chunkPages(
  pages: Page[],
  opts: { maxChars?: number; overlapChars?: number } = {},
): Chunk[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? 1600))
  const overlap = Math.max(0, Math.min(Math.floor(opts.overlapChars ?? 320), maxChars - 1))
  const chunks: Chunk[] = []
  let index = 0

  for (const { page, text } of pages) {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) continue

    let start = 0
    while (start < clean.length) {
      const hardEnd = Math.min(start + maxChars, clean.length)
      let end = hardEnd
      if (hardEnd < clean.length) {
        const lastSpace = clean.lastIndexOf(' ', hardEnd)
        if (lastSpace > start + maxChars * 0.5) end = lastSpace
      }
      const content = clean.slice(start, end).trim()
      if (content) chunks.push({ content, page, index: index++ })
      if (end >= clean.length) break
      start = Math.max(end - overlap, start + 1)
    }
  }

  return chunks
}
