/**
 * A minimal, deterministic PDF writer — just enough to put lines of Helvetica on
 * numbered pages.
 *
 * It exists so the example run goes through the *same* pipeline a visitor's
 * upload does: a real PDF, extracted by the real pdf.js, chunked by the real
 * `chunkPages`. Feeding the ingest function pre-split text would have been three
 * lines shorter and would have quietly skipped the two steps that produce page
 * numbers, which are what the citations are made of.
 *
 * Deterministic on purpose: the same source text always produces the same bytes,
 * so `contentHash` is stable and a regenerated fixture differs only where the
 * live system's answers differ.
 */

/** Left margin, first baseline and leading, in PDF points on a US Letter page. */
const MARGIN = 56
const FIRST_BASELINE = 736
const LEADING = 14
const FONT_SIZE = 10

/** `(`, `)` and `\` end or escape a PDF string literal, so they have to be
 *  escaped inside one. */
function escapeText(line) {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** The typographic characters these documents use, mapped to the WinAnsi code
 *  points the declared font encoding carries. `Buffer.from(…, 'latin1')` writes
 *  one byte per code unit, so U+2014 would otherwise be truncated to 0x14 and
 *  read back as a control character. */
const WIN_ANSI = new Map([
  ['—', '\x97'], // em dash
  ['–', '\x96'], // en dash
  ['‘', '\x91'], // left single quote
  ['’', '\x92'], // right single quote
  ['“', '\x93'], // left double quote
  ['”', '\x94'], // right double quote
  [' ', '\x20'], // no-break space
])

/**
 * Folds a line to bytes the declared encoding can carry.
 *
 * Anything still outside the encodable range after folding throws rather than
 * being written. It would round-trip through pdf.js as a different character,
 * and the fixture's chunk text would then quietly stop matching the source
 * module it was supposedly generated from.
 */
function toWinAnsi(line) {
  let out = ''
  for (const ch of line) {
    const mapped = WIN_ANSI.get(ch) ?? ch
    const code = mapped.codePointAt(0)
    if (mapped.length === 1 && code >= 0x20 && code <= 0xff) {
      out += mapped
      continue
    }
    const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    throw new Error(
      `pdf.mjs cannot encode U+${hex} in: ${line}\n` +
        'Add it to WIN_ANSI or use an ASCII equivalent.',
    )
  }
  return out
}

/**
 * @param {string[][]} pages One array of lines per page.
 * @returns {Buffer} The whole file.
 */
export function buildPdf(pages) {
  /** @type {(string|null)[]} 1-based: index 0 is object 1. */
  const objects = [null, null, null] // reserved: 1 catalog, 2 page tree, 3 font

  const push = (body) => {
    objects.push(body)
    return objects.length
  }

  const kids = []
  for (const lines of pages) {
    let content = `BT\n/F1 ${FONT_SIZE} Tf\n1 0 0 1 ${MARGIN} ${FIRST_BASELINE} Tm\n${LEADING} TL\n`
    for (const line of lines) content += `(${escapeText(toWinAnsi(line))}) Tj\nT*\n`
    content += 'ET\n'

    const contentNum = push(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    )
    const pageNum = push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    )
    kids.push(`${pageNum} 0 R`)
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefAt = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`

  return Buffer.from(out, 'latin1')
}

/**
 * Reads a PDF back the way the browser does.
 *
 * This mirrors `extractPdf` in `@labs/doc-core/extract`, which cannot be
 * imported here: it resolves the pdf.js worker through Vite's `?url` import,
 * which is meaningless under Node. The extraction itself — one page at a time,
 * text items joined with a space — is line for line the same, and the two have
 * to be kept that way or the fixture stops matching what an upload would produce.
 *
 * @param {Buffer} bytes
 * @returns {Promise<{ page: number, text: string }[]>}
 */
export async function extractPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // Errors only. Under Node, pdf.js warns that it cannot fetch standard font
    // data over a file: URL — true, and irrelevant: glyph outlines are needed to
    // *draw* a page, not to read the strings out of its content stream.
    verbosity: 0,
  }).promise

  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push({
      page: i,
      text: content.items.map((it) => ('str' in it ? it.str : '')).join(' '),
    })
  }
  return pages
}
