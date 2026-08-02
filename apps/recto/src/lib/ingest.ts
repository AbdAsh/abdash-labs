import { extractPages, chunkPages, contentHash, isRTL, type Chunk } from '@labs/doc-core'
import { supabase, SUPABASE_URL } from '@labs/platform'

/** Set by OpenAI's embedding request limits, not by Edge Function compute —
 *  Supabase's 2 s CPU / 150 s wall clock leave ample room at this size. */
const BATCH = 50

/** Only the first 4000 characters are sampled for direction. A document does not
 *  change script halfway through, and a whole book's text is wasted work. */
const DIRECTION_SAMPLE = 4000

export class DuplicateDocumentError extends Error {
  constructor() {
    super('This document is already in the notebook.')
    this.name = 'DuplicateDocumentError'
  }
}

async function authHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('No session yet — sign-in has not finished.')
  return `Bearer ${token}`
}

export async function ingestFile(
  file: File,
  notebookId: string,
  onProgress: (done: number, total: number) => void,
): Promise<{ documentId: string; name: string; isRtl: boolean }> {
  const pages = await extractPages(file)
  const chunks: Chunk[] = chunkPages(pages)
  if (chunks.length === 0) {
    throw new Error('No readable text found. If this is a scanned PDF, OCR support is coming.')
  }

  const hash = await contentHash(file)
  const rtl = isRTL(
    pages
      .map((p) => p.text)
      .join(' ')
      .slice(0, DIRECTION_SAMPLE),
  )
  const auth = await authHeader()

  let documentId: string | undefined
  for (let i = 0; i < chunks.length; i += BATCH) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/recto-ingest`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebookId,
        documentId,
        name: file.name,
        contentHash: hash,
        isRtl: rtl,
        pageCount: pages.length,
        chunks: chunks.slice(i, i + BATCH),
      }),
    })
    if (res.status === 409) throw new DuplicateDocumentError()
    if (!res.ok) throw new Error(`ingest failed (${res.status}): ${await res.text()}`)
    documentId = ((await res.json()) as { documentId: string }).documentId
    onProgress(Math.min(i + BATCH, chunks.length), chunks.length)
  }

  return { documentId: documentId!, name: file.name, isRtl: rtl }
}
