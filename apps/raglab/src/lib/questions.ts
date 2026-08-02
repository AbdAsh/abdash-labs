import type { GoldSpan, Question } from './metrics'

/**
 * Question-set construction.
 *
 * Labelling is the real bottleneck in retrieval evaluation — the reason most
 * teams never measure anything — so this module exists to make the first fifteen
 * labels cheap rather than to automate them away. A suggestion is a *candidate
 * passage*, never a finished label; nothing enters a run without the user
 * confirming it.
 *
 * On offsets: a suggester returns the verbatim passage it thinks answers the
 * question, and the span is derived here with `indexOf`. Asking any generator —
 * model or heuristic — for character indices directly produces confidently wrong
 * numbers; locating the quote ourselves makes the offsets correct by construction.
 */

export const MIN_QUESTIONS = 5

/** A proposed label before the user has confirmed it. */
export interface Suggestion {
  id: string
  text: string
  /** Verbatim passage from the document. */
  quote: string
}

export type Suggester = (text: string, count: number) => Promise<Suggestion[]>

/** Finds a verbatim passage in the document. Null when absent or ambiguous. */
export function locateQuote(text: string, quote: string): GoldSpan | null {
  const trimmed = quote.trim()
  if (trimmed.length === 0) return null
  const first = text.indexOf(trimmed)
  if (first === -1) return null
  if (text.indexOf(trimmed, first + 1) !== -1) return null
  return { start: first, end: first + trimmed.length }
}

/**
 * Is this label usable against this document?
 *
 * Rejects spans that fall outside the text, are inverted or empty, or are so
 * short that any chunk containing a common word would score a hit. Everything
 * downstream assumes a valid gold span, so this is the gate.
 */
export function validateGold(text: string, q: Question): boolean {
  const { start, end } = q.gold
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  if (start < 0 || end > text.length || start >= end) return false
  if (end - start < 20) return false
  if (q.text.trim().length === 0) return false
  return true
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'by', 'with',
  'that', 'this', 'these', 'those', 'shall', 'be', 'is', 'are', 'was', 'were',
  'it', 'its', 'as', 'at', 'from', 'any', 'all', 'not', 'no', 'nor', 'but',
  'which', 'who', 'their', 'they', 'them', 'have', 'has', 'had', 'such', 'other',
])

function keywords(sentence: string): string[] {
  return [...new Set(
    sentence.toLowerCase().match(/[a-z][a-z-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [],
  )]
}

/**
 * Offline candidate finder: the default suggester.
 *
 * Scores sentences by how much distinctive vocabulary they carry that the rest of
 * the document does not, which surfaces the passages a reader would call
 * "the part that says X". It drafts a question stub the user is expected to
 * rewrite — the point is to put a good passage in front of them, not to pretend
 * the question is finished.
 *
 * There is no LLM path here yet: the platform fixes the Edge Function namespace at
 * nine, and `raglab-embed` is this app's only entry. When a `raglab-suggest`
 * function is added, pass a model-backed `Suggester` to `suggestQuestions` and
 * nothing else in this module changes.
 */
export const heuristicSuggester: Suggester = async (text, count) => {
  const sentences = [...text.matchAll(/[^.!?\n]{40,400}[.!?]/g)]
    .map((m) => ({ quote: m[0]!.trim(), start: m.index! }))
    .filter((s) => /[a-z]/.test(s.quote))

  const documentFrequency = new Map<string, number>()
  for (const s of sentences) {
    for (const w of keywords(s.quote)) {
      documentFrequency.set(w, (documentFrequency.get(w) ?? 0) + 1)
    }
  }

  const scored = sentences.map((s) => {
    const words = keywords(s.quote)
    const rarity = words.reduce((n, w) => n + 1 / (documentFrequency.get(w) ?? 1), 0)
    return { ...s, score: rarity / Math.sqrt(Math.max(1, words.length)), words }
  })

  // Highest-signal sentences first, then spread across the document so the set
  // does not cluster in one section.
  const picked: typeof scored = []
  for (const candidate of [...scored].sort((a, b) => b.score - a.score)) {
    if (picked.length >= count) break
    if (picked.some((p) => Math.abs(p.start - candidate.start) < 200)) continue
    if (locateQuote(text, candidate.quote) === null) continue
    picked.push(candidate)
  }

  return picked
    .sort((a, b) => a.start - b.start)
    .map((p, i) => ({
      id: `s${String(i + 1).padStart(2, '0')}`,
      text: `What does the document say about ${p.words.slice(0, 3).join(', ')}?`,
      quote: p.quote,
    }))
}

/**
 * Proposes up to `count` candidate labels.
 *
 * Suggestions whose quote cannot be located, or is ambiguous, are dropped rather
 * than shown — an unlocatable quote would produce a span pointing at the wrong
 * passage, and a wrong label is worse than a missing one.
 */
export async function suggestQuestions(
  text: string,
  count: number,
  suggester: Suggester = heuristicSuggester,
): Promise<Question[]> {
  const suggestions = await suggester(text, count)
  const questions: Question[] = []
  for (const s of suggestions) {
    const gold = locateQuote(text, s.quote)
    if (!gold) continue
    const question: Question = { id: s.id, text: s.text, gold }
    if (validateGold(text, question)) questions.push(question)
  }
  return questions
}

/** Can a run start? Guards the button and reports why when it cannot. */
export function readyToRun(text: string, questions: Question[]): { ok: boolean; reason?: string } {
  const valid = questions.filter((q) => validateGold(text, q))
  if (valid.length < MIN_QUESTIONS) {
    return {
      ok: false,
      reason: `Confirm at least ${MIN_QUESTIONS} questions — ${valid.length} so far. `
        + 'Fewer than that and one lucky retrieval swings the whole score.',
    }
  }
  if (new Set(valid.map((q) => q.id)).size !== valid.length) {
    return { ok: false, reason: 'Two questions share an id.' }
  }
  return { ok: true }
}
