import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Page } from './chunk'

export function splitPlainText(text: string): Page[] {
  return [{ page: 1, text }]
}

async function extractPdf(file: File): Promise<Page[]> {
  // Imported lazily (not at module scope) so this module stays importable
  // under Vitest's Node environment, where pdfjs-dist's top-level
  // `new DOMMatrix()` call would otherwise throw for tests that only
  // exercise splitPlainText.
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
  const data = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages: Page[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
    pages.push({ page: i, text })
  }
  return pages
}

export async function extractPages(file: File): Promise<Page[]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return extractPdf(file)
  const text = await file.text()
  return splitPlainText(text)
}
