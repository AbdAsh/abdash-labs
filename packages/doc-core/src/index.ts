// The public surface of @labs/doc-core, imported by Recto, RAG Lab and
// GraphRead. Exactly these six names — nothing deeper, nothing extra.
// `splitPlainText` stays internal to ./extract, where its own test reaches it.
export type { Page, Chunk } from './chunk'
export { chunkPages } from './chunk'
export { extractPages } from './extract'
export { contentHash } from './hash'
export { isRTL } from './rtl'
