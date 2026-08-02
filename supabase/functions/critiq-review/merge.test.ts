import { assertEquals } from 'jsr:@std/assert@1'
import type { Dimension, Finding, Severity } from './checks.ts'
import { gradeDimensions, gradeOverall, mergeFindings } from './merge.ts'

function f(over: Partial<Finding> & { id: string }): Finding {
  return {
    source: 'check',
    dimension: 'metadata',
    severity: 'medium',
    title: over.id,
    evidence: 'measured',
    fix: 'do the thing',
    ...over,
  }
}

const check = (over: Partial<Finding> & { id: string }) => f({ ...over, source: 'check' })
const llm = (over: Partial<Finding> & { id: string }) => f({ ...over, source: 'llm' })

// ---------------------------------------------------------------------------
// Checks win
// ---------------------------------------------------------------------------

Deno.test('a check always beats an LLM finding on the same id', () => {
  const merged = mergeFindings(
    [check({ id: 'title-length', severity: 'medium', title: 'Title is too long' })],
    [llm({ id: 'title-length', severity: 'low', title: 'Consider shortening the title' })],
  )
  assertEquals(merged.filter((x) => x.id === 'title-length').length, 1)
  assertEquals(merged[0]?.source, 'check')
  assertEquals(merged[0]?.severity, 'medium')
})

Deno.test('id matching survives the punctuation the model chooses', () => {
  const merged = mergeFindings(
    [check({ id: 'title-length' })],
    [
      llm({ id: 'title_length' }),
      llm({ id: 'TITLE-LENGTH' }),
      llm({ id: 'title length' }),
    ],
  )
  assertEquals(merged.length, 1)
  assertEquals(merged[0]?.source, 'check')
})

Deno.test('a finding is never relabelled by whatever the model claims to be', () => {
  const merged = mergeFindings(
    [],
    [{ ...f({ id: 'intent-mismatch' }), source: 'check' } as Finding],
  )
  assertEquals(merged[0]?.source, 'llm')
})

Deno.test('duplicate ids within one list collapse to the first', () => {
  const merged = mergeFindings(
    [check({ id: 'h1-missing', title: 'first' }), check({ id: 'h1-missing', title: 'second' })],
    [],
  )
  assertEquals(merged.length, 1)
  assertEquals(merged[0]?.title, 'first')
})

// ---------------------------------------------------------------------------
// Near-duplicate collapse
// ---------------------------------------------------------------------------

Deno.test('near-duplicate titles in the same dimension collapse', () => {
  const merged = mergeFindings(
    [check({ id: 'title-length', dimension: 'metadata', title: 'Title is too long' })],
    [
      llm({
        id: 'overlong-title',
        dimension: 'metadata',
        title: 'The page title exceeds recommended length',
      }),
    ],
  )
  assertEquals(merged.length, 1)
  assertEquals(merged[0]?.source, 'check')
})

Deno.test('collapse is scoped to one dimension', () => {
  // Same words, different subject: an alt-text finding about images is not the
  // same claim as a link finding about images.
  const merged = mergeFindings(
    [check({ id: 'img-alt-missing', dimension: 'structure', title: 'Images are missing alt text' })],
    [llm({ id: 'image-links', dimension: 'links', title: 'Image links are missing descriptions' })],
  )
  assertEquals(merged.length, 2)
})

Deno.test('genuinely different findings in the same dimension both survive', () => {
  const merged = mergeFindings(
    [check({ id: 'title-length', dimension: 'metadata', title: 'Title is too long' })],
    [
      llm({
        id: 'description-generic',
        dimension: 'metadata',
        title: 'The meta description could be written by any competitor',
      }),
    ],
  )
  assertEquals(merged.length, 2)
})

Deno.test('two LLM findings that say the same thing collapse against each other', () => {
  const merged = mergeFindings([], [
    llm({ id: 'a', dimension: 'content', title: 'The content is thin and superficial' }),
    llm({ id: 'b', dimension: 'content', title: 'Content is superficial and thin' }),
  ])
  assertEquals(merged.length, 1)
  assertEquals(merged[0]?.id, 'a')
})

Deno.test('a one-word title only collapses against an identical one', () => {
  const merged = mergeFindings([], [
    llm({ id: 'a', dimension: 'content', title: 'Thin' }),
    llm({ id: 'b', dimension: 'content', title: 'The content is thin, shallow and repetitive' }),
  ])
  assertEquals(merged.length, 2)
})

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

Deno.test('sorts critical first, then high, medium, low', () => {
  const merged = mergeFindings(
    [
      check({ id: 'low-1', severity: 'low' }),
      check({ id: 'critical-1', severity: 'critical' }),
      check({ id: 'medium-1', severity: 'medium' }),
      check({ id: 'high-1', severity: 'high' }),
    ],
    [],
  )
  assertEquals(merged.map((x) => x.severity), ['critical', 'high', 'medium', 'low'])
})

Deno.test('within a severity, checks are listed before LLM judgment', () => {
  const merged = mergeFindings(
    [check({ id: 'measured', severity: 'high', dimension: 'content' })],
    [llm({ id: 'judged', severity: 'high', dimension: 'content' })],
  )
  assertEquals(merged.map((x) => x.source), ['check', 'llm'])
})

Deno.test('ordering is stable and deterministic', () => {
  const build = () => [
    check({ id: 'b', severity: 'high', dimension: 'links' }),
    check({ id: 'a', severity: 'high', dimension: 'links' }),
    check({ id: 'c', severity: 'high', dimension: 'crawlability' }),
  ]
  const first = mergeFindings(build(), []).map((x) => x.id)
  const second = mergeFindings(build(), []).map((x) => x.id)
  assertEquals(first, second)
  // Dimension order breaks the tie before id does.
  assertEquals(first, ['c', 'a', 'b'])
})

Deno.test('merging two empty lists yields an empty list', () => {
  assertEquals(mergeFindings([], []), [])
})

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const at = (dimension: Dimension, severity: Severity, n = 1) =>
  Array.from({ length: n }, (_, i) => f({ id: `${dimension}-${severity}-${i}`, dimension, severity }))

Deno.test('a dimension with no findings stays at A', () => {
  const grades = gradeDimensions([])
  assertEquals(Object.keys(grades).length, 7)
  for (const grade of Object.values(grades)) assertEquals(grade, 'A')
})

Deno.test('severity demotes by the documented weights', () => {
  assertEquals(gradeDimensions(at('content', 'critical')).content, 'D') // −3
  assertEquals(gradeDimensions(at('content', 'high')).content, 'C') //     −2
  assertEquals(gradeDimensions(at('content', 'medium')).content, 'B') //   −1
  assertEquals(gradeDimensions(at('content', 'low')).content, 'B') //      −0.5, rounded
  assertEquals(gradeDimensions(at('content', 'low', 4)).content, 'C') //   −2
})

Deno.test('grades floor at F rather than running off the end', () => {
  assertEquals(gradeDimensions(at('content', 'critical', 5)).content, 'F')
})

Deno.test('a finding in one dimension does not demote the others', () => {
  const grades = gradeDimensions(at('crawlability', 'critical'))
  assertEquals(grades.crawlability, 'D')
  assertEquals(grades.metadata, 'A')
  assertEquals(grades['answer-engine'], 'A')
})

Deno.test('an unknown dimension from the model cannot corrupt the grade map', () => {
  const grades = gradeDimensions([
    f({ id: 'x', dimension: 'nonsense' as Dimension, severity: 'critical' }),
  ])
  assertEquals(Object.keys(grades).length, 7)
  for (const grade of Object.values(grades)) assertEquals(grade, 'A')
})

Deno.test('the overall grade refuses to average away a catastrophic dimension', () => {
  assertEquals(gradeOverall([]), 'A')
  // One critical in one of seven dimensions still has to read as bad.
  assertEquals(gradeOverall(at('content', 'critical')), 'C')
  assertEquals(gradeOverall(at('content', 'medium')), 'A')
  const everywhere = ([
    'crawlability',
    'metadata',
    'content',
    'structure',
    'links',
    'structured-data',
    'answer-engine',
  ] as Dimension[]).flatMap((d) => at(d, 'critical', 2))
  assertEquals(gradeOverall(everywhere), 'F')
})
