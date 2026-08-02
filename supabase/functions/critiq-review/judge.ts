/**
 * LLM judgment findings.
 *
 * The model is asked for the half of an SEO review that cannot be measured:
 * whether the title is *compelling*, whether the H1 promises something the body
 * delivers, whether the page answers the intent it targets, and — the
 * differentiating question — whether an answer engine could lift a correct,
 * self-contained, attributable claim out of this page.
 *
 * It is explicitly told which deterministic checks already fired and instructed
 * not to restate them. `mergeFindings` enforces that afterwards regardless,
 * because a prompt is a request and the merge is a guarantee.
 */
import { chatJSON, type Message } from '../_shared/openrouter.ts'
import { DIMENSIONS, type Finding, SEVERITIES } from './checks.ts'
import type { Digest } from './digest.ts'

/** Bounded so one page cannot turn into an unreadable wall or a huge bill. */
const MAX_FINDINGS = 12
const MAX_HEADINGS = 60
const MAX_LINKS = 60
const MAX_JSONLD_TYPES = 20

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'dimension', 'severity', 'title', 'evidence', 'fix', 'code'],
        properties: {
          id: {
            type: 'string',
            description: 'kebab-case identifier for this kind of judgment, e.g. intent-mismatch',
          },
          dimension: { type: 'string', enum: DIMENSIONS },
          severity: { type: 'string', enum: SEVERITIES },
          title: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'Quote the actual text or markup from the page that supports this.',
          },
          fix: { type: 'string' },
          code: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const

const SYSTEM = `You are a senior SEO and answer-engine-optimisation practitioner reviewing one page.

You are the JUDGMENT half of a hybrid tool. A deterministic rule engine has already
measured everything measurable — tag presence, lengths, counts, parse validity, HTTP
mechanics — and its findings are authoritative. Your job is the part a rule cannot do.

Report only judgments such as:
- Is the title specific and compelling, or could it sit on any competitor's page?
- Does the description earn a click, or does it merely describe?
- What search intent does this page target, and does the body actually satisfy it?
- Does the heading outline reflect a real argument, or is it decorative?
- Is the internal linking sensible for the role this page plays on the site?
- Is the chosen schema.org type appropriate and complete for what this page is?
- ANSWER-ENGINE READINESS: could a model quote a correct, self-contained, attributable
  claim from this page? Are claims sourced, are entities named unambiguously rather than
  as "we" and "our platform", and does any passage stand on its own out of context?

Hard rules:
- NEVER restate a check that already fired. You are given their ids.
- NEVER report something you can only guess at. If the extracted text does not support a
  claim, do not make it.
- Every finding must quote real evidence from the supplied page text or markup.
- Every fix must be specific enough to act on without asking a follow-up question.
- Prefer a handful of findings that matter to a long list. Zero findings is a valid answer
  for a genuinely good page.
- Reserve 'critical' for something that stops the page ranking or being cited at all.`

export async function judge(d: Digest, checkIds: string[]): Promise<Finding[]> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildPrompt(d, checkIds) },
  ]

  const result = await chatJSON<{ findings?: unknown[] }>(messages, SCHEMA)
  const raw = Array.isArray(result?.findings) ? result.findings : []

  return raw.slice(0, MAX_FINDINGS).map(toFinding).filter((f): f is Finding => f !== null)
}

function buildPrompt(d: Digest, checkIds: string[]): string {
  // mainText is sent separately; sending it inside the JSON too would double the
  // largest part of the payload.
  const structure = {
    url: d.finalUrl,
    status: d.status,
    redirects: d.redirects,
    title: d.title,
    description: d.description,
    canonical: d.canonical,
    lang: d.lang,
    og: d.og,
    twitter: d.twitter,
    headingOutline: d.headings.slice(0, MAX_HEADINGS).map((h) => `h${h.level}: ${h.text}`),
    jsonLdTypes: d.jsonLd.flatMap((b) => b.types).slice(0, MAX_JSONLD_TYPES),
    counts: {
      words: d.wordCount,
      paragraphs: d.paragraphs,
      lists: d.lists,
      listItems: d.listItems,
      tables: d.tables,
      questionHeadings: d.questionHeadings,
      images: d.images.length,
      internalLinks: d.internalLinks,
      externalLinks: d.externalLinks,
    },
    internalLinkSample: d.links
      .filter((l) => l.internal && l.text !== '')
      .slice(0, MAX_LINKS)
      .map((l) => `${l.text} → ${l.href}`),
    externalLinkSample: d.links
      .filter((l) => !l.internal && l.text !== '')
      .slice(0, MAX_LINKS)
      .map((l) => `${l.text} → ${l.href}`),
  }

  return [
    'PAGE STRUCTURE (JSON):',
    JSON.stringify(structure, null, 2),
    '',
    'CHECKS THAT ALREADY FIRED — do not restate any of these:',
    checkIds.length > 0 ? checkIds.join(', ') : '(none)',
    '',
    'EXTRACTED PAGE TEXT:',
    d.mainText.trim() === '' ? '(the page returned no readable text)' : d.mainText,
  ].join('\n')
}

function toFinding(raw: unknown): Finding | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (id === '' || title === '') return null
  if (!DIMENSIONS.includes(r.dimension as Finding['dimension'])) return null

  return {
    id,
    source: 'llm',
    dimension: r.dimension as Finding['dimension'],
    severity: SEVERITIES.includes(r.severity as Finding['severity'])
      ? (r.severity as Finding['severity'])
      : 'medium',
    title,
    evidence: typeof r.evidence === 'string' ? r.evidence.trim() : '',
    fix: typeof r.fix === 'string' ? r.fix.trim() : '',
    ...(typeof r.code === 'string' && r.code.trim() !== '' ? { code: r.code } : {}),
  }
}
