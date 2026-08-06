/**
 * Evidence is not one kind of thing, and rendering it as if it were is what
 * makes a report hard to read.
 *
 * A finding's `evidence` is whatever supports it, and across the twenty-three
 * checks that is three different things:
 *
 *   `<img src="hero.png">`                      the offending markup
 *   `https://a/ \n  → https://b/`               a measured chain
 *   `65 characters (aim for 25–65): "…"`        a sentence about a measurement
 *
 * Dropping all three into one `<pre>` renders the sentence in a code box and
 * the markup without any of the structure that makes markup scannable. This
 * module splits evidence into runs of one kind and tokenises the markup, so the
 * component can render each as what it is.
 *
 * Everything here is a pure function over a string. No DOM, no `innerHTML`:
 * evidence is attacker-influenced — it is quoted from a page a stranger asked
 * us to fetch — so it is only ever rendered as React text nodes.
 */

export type EvidenceKind = 'markup' | 'code' | 'text'

export interface EvidenceRun {
  kind: EvidenceKind
  lines: string[]
}

export type TokenType = 'punct' | 'tag' | 'attr' | 'value' | 'text'

export interface Token {
  type: TokenType
  text: string
}

const MARKUP_LINE = /^\s*<\/?[a-zA-Z!/?]/
const JSON_LINE = /^\s*[{[]/
const URL_LINE = /^\s*(?:→|->|https?:\/\/)/
const ARROW_PAIR = /\s(?:→|->)\s/

/** Classifies one line of evidence. Exported for the tests that pin the rules. */
export function lineKind(line: string): EvidenceKind {
  if (MARKUP_LINE.test(line)) return 'markup'
  if (JSON_LINE.test(line) || URL_LINE.test(line) || ARROW_PAIR.test(line)) return 'code'
  return 'text'
}

/**
 * Splits evidence into consecutive runs of one kind, preserving order.
 *
 * Blank lines are dropped rather than given a kind of their own: they would
 * otherwise break a block of markup into two boxes with a gap between them.
 */
export function classifyEvidence(evidence: string | null | undefined): EvidenceRun[] {
  const lines = (evidence ?? '').split('\n').filter((line) => line.trim() !== '')
  const runs: EvidenceRun[] = []

  for (const line of lines) {
    const kind = lineKind(line)
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) last.lines.push(line)
    else runs.push({ kind, lines: [line] })
  }

  return runs
}

const TAG_CHUNK = /(<[^<>]*>)/g
const ATTRIBUTE = /([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g

/**
 * Tokenises a line of HTML for display.
 *
 * Not a parser and not trying to be: it never validates, never balances tags,
 * and hands anything it does not recognise back as plain text. The only job is
 * that a reader's eye can find the tag name and the attribute value.
 */
export function tokenizeMarkup(line: string): Token[] {
  const out: Token[] = []
  const push = (type: TokenType, text: string) => {
    if (text === '') return
    const last = out[out.length - 1]
    if (last && last.type === type) last.text += text
    else out.push({ type, text })
  }

  for (const chunk of line.split(TAG_CHUNK)) {
    if (chunk === '') continue
    if (!(chunk.startsWith('<') && chunk.endsWith('>'))) {
      push('text', chunk)
      continue
    }

    const inner = chunk.slice(1, -1)
    // Group 1 keeps the whitespace and the optional slash exactly as written, so
    // `<` + group 1 + the name reproduces the prefix character for character.
    // `a < b and c > d` is prose that happens to look like a tag, and losing the
    // space while re-rendering it would be the module editing the evidence.
    const name = /^(\s*\/?\s*)([a-zA-Z!?][\w:.-]*)/.exec(inner)
    if (!name) {
      push('punct', chunk)
      continue
    }

    push('punct', `<${name[1] ?? ''}`)
    push('tag', name[2] ?? '')

    const rest = inner.slice(name[0].length)
    let cursor = 0
    ATTRIBUTE.lastIndex = 0
    for (let m = ATTRIBUTE.exec(rest); m !== null; m = ATTRIBUTE.exec(rest)) {
      push('text', rest.slice(cursor, m.index))
      push('attr', m[1] ?? '')
      push('punct', m[2] ?? '')
      push('value', m[3] ?? '')
      cursor = m.index + m[0].length
    }
    push('text', rest.slice(cursor))
    push('punct', '>')
  }

  return out
}

/**
 * True when this evidence is worth showing at all.
 *
 * A finding whose evidence is a restatement of its own title is noise dressed
 * as proof, and the report is better off omitting the block than printing the
 * same sentence twice under a heading that says "Evidence".
 */
export function evidenceAddsSomething(
  evidence: string | null | undefined,
  title: string | null | undefined,
): boolean {
  const e = normalize(evidence)
  if (e === '') return false
  return e !== normalize(title)
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
