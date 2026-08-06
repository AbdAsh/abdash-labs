/**
 * The extraction pipeline: file → pages → coarse chunks → graph.
 *
 * Chunking comes from `@labs/doc-core` — the same code Recto and RAG Lab use,
 * asked for a coarser 2500-char chunk through its existing parameter. GraphRead
 * owns no chunker of its own, and the moment it did, the three would drift.
 */

import { chunkPages, extractPages, type Page } from '@labs/doc-core'
import { supabase } from '@labs/platform'
import { functionError, QuotaError } from './errors'
import { assemble, type Graph } from './graph'
import { embeddingPass, lexicalPass } from './resolve'
import type { ChunkExtraction, RawEntity } from './validate'

/**
 * Coarser than Recto's retrieval chunks on purpose. Relation extraction needs
 * enough context for both endpoints of a claim to sit in the same window; a
 * 1600-char chunk splits "X founded Y" from the sentence that names Y.
 */
export const CHUNK_MAX_CHARS = 2500

/** Four in flight keeps a 60-chunk document inside the 30–90 s theatre window. */
const CONCURRENCY = 4

export interface SourceChunk {
  id: string
  page: number
  content: string
}

export interface RunProgress {
  done: number
  total: number
  graph: Graph
  failed: number
}

export interface RunResult {
  graph: Graph
  chunks: SourceChunk[]
  extractions: ChunkExtraction[]
  /**
   * Chunks that never came back. The graph is built from the rest rather than
   * thrown away — a graph missing four passages of thirty is worth far more
   * than an error page — but the caller has to say so, because a silently
   * partial graph is a dishonest one.
   */
  failedChunks: string[]
  /** True when the run gave up early: quota exhausted, or the user cancelled. */
  stoppedEarly: boolean
}

export interface RunOptions {
  onProgress?: (p: RunProgress) => void
  signal?: AbortSignal
  /** Skip resolution pass 2. Useful offline, and the fallback if embedding dies. */
  skipEmbeddingPass?: boolean
}

export function toSourceChunks(pages: Page[]): SourceChunk[] {
  return chunkPages(pages, { maxChars: CHUNK_MAX_CHARS }).map((c) => ({
    id: `c${c.index}`,
    page: c.page,
    content: c.content,
  }))
}

export async function pagesFromFile(file: File): Promise<Page[]> {
  return extractPages(file)
}

async function extractChunk(chunk: SourceChunk, chunkIndex: number): Promise<ChunkExtraction> {
  const { data, error } = await supabase.functions.invoke<{
    chunkId: string
    entities: RawEntity[]
    relations: ChunkExtraction['relations']
  }>('graphread-extract', {
    body: { chunkId: chunk.id, chunkIndex, text: chunk.content },
  })
  if (error) throw await functionError(error, 'The extractor could not be reached.')
  return {
    chunkId: chunk.id,
    entities: Array.isArray(data?.entities) ? data.entities : [],
    relations: Array.isArray(data?.relations) ? data.relations : [],
  }
}

/** Rebuilds the graph from whatever has arrived so far — lexical pass only. */
function snapshot(
  extractions: ChunkExtraction[],
  chunkTexts: Map<string, string>,
  total: number,
): Graph {
  const mentions = extractions.flatMap((x) =>
    x.entities.map((entity) => ({ entity, chunkId: x.chunkId })),
  )
  const g = assemble(extractions, lexicalPass(mentions), chunkTexts)
  return { ...g, stats: { ...g.stats, chunks: total } }
}

/**
 * Runs the whole pipeline, reporting a live graph as each chunk lands. Watching
 * the graph assemble itself is the demo, and it doubles as honest progress —
 * the nodes on screen are the nodes that actually came back.
 */
export async function runExtraction(
  chunks: SourceChunk[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { onProgress, signal, skipEmbeddingPass } = options
  const chunkTexts = new Map(chunks.map((c) => [c.id, c.content]))
  const extractions: ChunkExtraction[] = []
  const failedChunks: string[] = []
  let done = 0
  let quotaStopped = false

  const report = () => {
    onProgress?.({
      done,
      total: chunks.length,
      failed: failedChunks.length,
      graph: snapshot(extractions, chunkTexts, chunks.length),
    })
  }

  const settle = (chunk: SourceChunk, result: ChunkExtraction | null) => {
    if (result) extractions.push(result)
    else failedChunks.push(chunk.id)
    done += 1
    report()
  }

  if (chunks.length === 0) {
    return {
      graph: snapshot([], chunkTexts, 0),
      chunks,
      extractions,
      failedChunks,
      stoppedEarly: false,
    }
  }

  // The first chunk goes alone and carries chunkIndex 0, which is what charges
  // the per-document quota. If the user is out of allowance they find out after
  // one request instead of sixty.
  const first = chunks[0]!
  try {
    settle(first, await extractChunk(first, 0))
  } catch (e) {
    // A quota rejection is the user's answer, not a partial result.
    if (e instanceof QuotaError) throw e
    settle(first, null)
  }

  const queue = chunks.slice(1)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      const index = cursor++
      const chunk = queue[index]
      if (!chunk) return
      try {
        settle(chunk, await extractChunk(chunk, index + 1))
      } catch (e) {
        // Mid-run the allowance can still run out. Stop asking rather than
        // grinding through the remaining chunks collecting the same refusal.
        if (e instanceof QuotaError) {
          quotaStopped = true
          settle(chunk, null)
          return
        }
        settle(chunk, null)
      }
      if (quotaStopped) return
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))

  const mentions = extractions.flatMap((x) =>
    x.entities.map((entity) => ({ entity, chunkId: x.chunkId })),
  )
  const lexical = lexicalPass(mentions)
  const nodes = skipEmbeddingPass ? lexical : await embeddingPass(lexical)

  const graph = assemble(extractions, nodes, chunkTexts)
  return {
    graph: { ...graph, stats: { ...graph.stats, chunks: chunks.length } },
    chunks,
    extractions,
    failedChunks,
    stoppedEarly: quotaStopped || signal?.aborted === true,
  }
}
