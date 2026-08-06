/**
 * The server half of AskSheet's privacy boundary, for the payload nobody thinks
 * about: the DuckDB error text on a repair round-trip.
 *
 * Every message asserted on below is real output from the DuckDB build the client
 * ships, captured by running the failing statement against a table holding those
 * cells. The client redacts them too; this suite exists because the client's
 * promise is not enforcement.
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

import { disclosedTokens, MAX_ERROR_CHARS, redactSqlError } from './redact.ts'

const profile = {
  table: 'data',
  columns: [{ name: 'patient' }, { name: 'ssn' }, { name: 'note' }, { name: 'amount' }],
}
const allowed = disclosedTokens(profile, 'select cast(ssn as integer) from data')

Deno.test('strips the cell value out of a real conversion error', () => {
  const real =
    "Conversion Error: Could not convert string '111-22-3333' to INT32 when casting from source column ssn\n\nLINE 2: select cast(ssn as integer) from data\n               ^"
  const out = redactSqlError(real, allowed)

  assert(!out.includes('111-22-3333'), out)
  // The diagnosis has to survive, or the repair round-trip is worthless.
  assertStringIncludes(out, 'Conversion Error')
  assertStringIncludes(out, 'INT32')
  assertStringIncludes(out, 'ssn')
})

Deno.test('strips a cell DuckDB echoes on its own line beneath a caret', () => {
  const real =
    'Invalid Input Error: Could not parse string "severe migraine" according to format specifier "%Y-%m-%d"\nsevere migraine\n^\nError: Expected a number'
  const out = redactSqlError(real, allowed)

  assert(!out.includes('severe migraine'), out)
  assertStringIncludes(out, 'Invalid Input Error')
})

Deno.test('strips a name out of an invalid-date error but keeps the column', () => {
  const real =
    'Conversion Error: invalid date field format: "Alice Kowalski", expected format is (YYYY-MM-DD) when casting from source column patient'
  const out = redactSqlError(real, allowed)

  assert(!out.includes('Alice Kowalski'), out)
  assertStringIncludes(out, 'patient')
  assertStringIncludes(out, 'YYYY-MM-DD')
})

Deno.test('keeps candidate bindings, which are column names already sent', () => {
  const real =
    'Binder Error: Referenced column "nosuchcol" not found in FROM clause!\nCandidate bindings: "note", "amount"'
  const out = redactSqlError(real, allowed)

  assertStringIncludes(out, 'note')
  assertStringIncludes(out, 'amount')
  assertStringIncludes(out, 'Binder Error')
})

Deno.test('allowlists rather than denylists — an unknown quoted token is a cell', () => {
  const out = redactSqlError("Some Error: value 'never-seen-before' is bad", allowed)
  assert(!out.includes('never-seen-before'), out)
})

Deno.test('drops the SQL echo, already carried verbatim as repair.sql', () => {
  const out = redactSqlError(
    'Binder Error: something\n\nLINE 2: select secret_literal from data\n               ^',
    allowed,
  )
  assert(!out.includes('secret_literal'), out)
})

Deno.test('scrubs an unquoted numeric cell but leaves type names intact', () => {
  const out = redactSqlError(
    "Conversion Error: Type INT64 with value 987654321098 can't be cast to INT32",
    allowed,
  )
  assert(!out.includes('987654321098'), out)
  assertStringIncludes(out, 'INT64')
  assertStringIncludes(out, 'INT32')
})

Deno.test('does not mangle digits inside an allowlisted column name', () => {
  const named = { table: 'data', columns: [{ name: 'q1 2024 revenue' }] }
  const out = redactSqlError(
    'Binder Error: Referenced column "q1 2024 revenue" not found',
    disclosedTokens(named, ''),
  )
  assertStringIncludes(out, 'q1 2024 revenue')
})

Deno.test('caps the length', () => {
  const out = redactSqlError(`Binder Error: ${'padding text '.repeat(200)}`, allowed)
  assert(out.length <= MAX_ERROR_CHARS, `length was ${out.length}`)
})

Deno.test('fails closed on an empty or non-string message', () => {
  assertEquals(redactSqlError('', allowed), 'The query failed without an error message.')
  assertEquals(redactSqlError(undefined, allowed), 'The query failed without an error message.')
  assert(!redactSqlError({ toString: () => "'secret'" }, allowed).includes('secret'))
})

Deno.test('redacts everything when the vocabulary is empty', () => {
  const out = redactSqlError('Binder Error: column "patient" not found', new Set<string>())
  assert(!out.includes('patient'), out)
})

Deno.test('disclosedTokens covers table, columns and the SQL being repaired', () => {
  const tokens = disclosedTokens(
    { table: 'sheet', columns: [{ name: 'amount' }] },
    'select try_cast(amount as int) from sheet',
  )
  assert(tokens.has('sheet'))
  assert(tokens.has('amount'))
  assert(tokens.has('try_cast'))
  assert(!tokens.has('never_mentioned'))
})
