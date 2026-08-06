import { extractPages, chunkPages, contentHash, isRTL, type Chunk } from '@labs/doc-core'
import { callFunction, functionError } from './functions'
import { deleteDocument } from './documents'

/** Set by OpenAI's embedding request limits, not by Edge Function compute —
 *  Supabase's 2 s CPU / 150 s wall clock leave ample room at this size. */
const BATCH = 50

/** Only the first 4000 characters are sampled for direction. A document does not
 *  change script halfway through, and a whole book's text is wasted work. */
const DIRECTION_SAMPLE = 4000

/** Reading and chunking a long PDF takes seconds with no server involved, so it
 *  is reported as its own phase. Without it the interface sits on "0 of 0
 *  passages" for the whole of the slowest part and looks wedged. */
export type IngestPhase = 'reading' | 'indexing'

export interface IngestProgress {
  phase: IngestPhase
  done: number
  total: number
}

export class DuplicateDocumentError extends Error {
  constructor() {
    super('This document is already in the notebook.')
    this.name = 'DuplicateDocumentError'
  }
}

/**
 * Extract, chunk and upload one file.
 *
 * The document row is created by the first batch and only promoted to `ready`
 * by the last, so an upload that dies in between leaves something visibly
 * unfinished rather than a document that looks whole and answers from its first
 * fifty passages. When a batch fails, the half-built row is removed — both
 * because a partial document is worth nothing and because the unique content
 * hash would otherwise refuse the retry.
 */
export async function ingestFile(
  file: File,
  notebookId: string,
  onProgress: (progress: IngestProgress) => void,
): Promise<{ documentId: string; name: string; isRtl: boolean }> {
  onProgress({ phase: 'reading', done: 0, total: 0 })

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

  onProgress({ phase: 'indexing', done: 0, total: chunks.length })

  let documentId: string | undefined
  try {
    for (let i = 0; i < chunks.length; i += BATCH) {
      const final = i + BATCH >= chunks.length
      const res = await callFunction('recto-ingest', {
        notebookId,
        documentId,
        name: file.name,
        contentHash: hash,
        isRtl: rtl,
        pageCount: pages.length,
        chunks: chunks.slice(i, i + BATCH),
        final,
      })

      if (res.status === 409) throw new DuplicateDocumentError()
      if (!res.ok) throw new Error(await functionError(res))
      documentId = ((await res.json()) as { documentId: string }).documentId
      onProgress({
        phase: 'indexing',
        done: Math.min(i + BATCH, chunks.length),
        total: chunks.length,
      })
    }
  } catch (e) {
    // Best effort: if this fails too the row stays `indexing`, which the
    // sources list shows as unfinished with a way to remove it by hand.
    if (documentId) await deleteDocument(documentId).catch(() => {})
    throw e
  }

  return { documentId: documentId!, name: file.name, isRtl: rtl }
}
