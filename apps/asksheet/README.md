# AskSheet

Drop a CSV, ask questions in English, get answers with visible SQL and charts —
with the data never leaving the browser.

Deployed at `labs.abdash.net/asksheet`.

---

## The claim

Every "chat with your data" product uploads your data. This one does not.

The file is parsed and queried by **DuckDB-WASM inside your browser tab**. The only
thing that crosses the network is a *schema profile* — column names, inferred
types, the row count, and at most five short example values per column — plus your
question. In **strict mode** even the example values are dropped and the server
sees names and types only.

## Proof of claim — verify it yourself in thirty seconds

This is the headline claim, so it has to be checkable by a sceptic rather than
taken on trust.

1. Open `https://labs.abdash.net/asksheet` (or `npm run dev -w apps/asksheet`).
2. Open **DevTools → Network** and tick **Preserve log**.
3. Load the **SaaS revenue** sample and ask
   *"Which month had the highest revenue and why is it an outlier?"*
4. Look at every request in the list.

What you will see:

- Requests to `cdn.jsdelivr.net` for `duckdb-eh.wasm` and its worker. Those are
  **downloads**, not uploads — the engine coming to the data.
- Exactly one request to `.../functions/v1/asksheet-plan` per question. Click it,
  open **Payload**, and read the whole body. It contains `profile` (column names,
  types, row count, up to five example values each), `history` (your earlier
  questions and the SQL they produced), `question`, and — only when a query failed
  and is being retried — `repair`, holding that SQL and a redacted error. Nothing
  else.
- **No request carrying rows.** Not to `asksheet-plan`, not anywhere.

Now tick **Strict mode** in the privacy panel and ask another question. The
`samples` arrays in the next payload are all empty, and the conversation resets —
see below for why that is not an inconvenience but part of the claim.

For reference, a full profile of the 219-row bundled sample is **711 bytes**, and
600 bytes in strict mode.

The same check runs as an assertion in CI, at five levels:

| Level | File | What it pins |
| --- | --- | --- |
| Unit | `src/lib/profile.test.ts` | The emitted object has exactly the keys `columns`, `rowCount`, `table` — asserted **by exclusion**, so a future field cannot slip in |
| Loop | `src/lib/plan.test.ts` | A result is never forwarded to the planner, even across a repair round-trip |
| Engine | `src/lib/duck.test.ts` | Against a real DuckDB, no cell value appears anywhere in a strict-mode profile |
| Row | `src/lib/duck.test.ts` | Against the real bundled sample, **zero of 219 source rows** can be reconstructed from a normal-mode payload |
| Error | `src/lib/duck.test.ts`, `supabase/functions/asksheet-plan/redact.test.ts` | A real DuckDB conversion failure names the offending cell; the text that leaves does not contain it |

### Why those last two rows exist

Counting disclosed values is the wrong measure. The right one is what can be
*rebuilt* from them, and the two have now come apart twice.

**The alignment leak.** Sampling each column with a bare `limit 5` returns values
in insertion order, so the k-th sample of every column came from the same source
row. Five complete records of the bundled sample were reconstructible verbatim
from the outbound request — while every unit test passed, because each individual
value was legitimately disclosed and the payload shape was exactly as promised. It
was only visible by reading the bytes in DevTools.

Sorting each column independently with `order by 1` broke the alignment, and
introduced a smaller problem of its own: the five *lowest* values of every column.
For a salary, a date or a customer name that is a more pointed disclosure than
five arbitrary values, and "up to five example values" is not a promise to hand
over the extremes of every distribution. The sample query now orders by
`hash(value)` over a bounded scan — uncorrelated between columns, so the alignment
stays broken; uncorrelated with the values, so no order statistic escapes; and
deterministic, which is itself a privacy property, since a fresh random sample
each turn would disclose new values on every question.

**The error echo.** DuckDB puts cell values in its error messages, verbatim:

```
Conversion Error: Could not convert string '111-22-3333' to INT32
  when casting from source column ssn
Invalid Input Error: Could not parse string "severe migraine"
  according to format specifier "%Y-%m-%d"
severe migraine
^
```

Those are captured from the engine this app ships, and this is not an edge case:
the planner is explicitly instructed to cast text that holds numbers or dates, so
a failed cast is the likeliest reason a repair round-trip happens at all. The
commonest retry was therefore the one carrying a cell. `repair.error` was
`error.message` — right shape, right key count, wrong contents.

`redactSqlError` keeps the diagnosis and drops everything else. A quoted run
survives only if it exactly matches a column name, the table name, or an
identifier in the SQL already being sent; bare numbers of two or more digits go;
the `LINE n:` echo and the value-under-a-caret line go. It is an **allowlist**, so
it holds for error shapes nobody has catalogued — an unrecognised quoted token is
assumed to be a cell, because a cell is the thing it costs most to be wrong about.
The user still sees the full, unredacted error; only the copy that crosses the
network is stripped.

### Strict mode clears the conversation

Strict mode promises the server sees names and types only. Follow-ups carry the
SQL of earlier turns, and that SQL holds literals — `where region = 'EMEA'` — that
came from sample values or from what was typed. Sending those under a schema-only
badge would make the badge a lie, so enabling strict mode drops the history and
says so.

## How it works

```
File ──► PapaParse preflight ──► DuckDB-WASM table (worker thread)
                │                        │
        (error messages only)      profile: names, types, row count, ≤5 samples
                                         │
                              fetch ──► supabase/functions/asksheet-plan
                                         │      └─ OpenRouter MODEL_CHEAP
                                         ▼      strict JSON { sql, chart?, narration }
                              assertSingleSelect ──► DuckDB runs it locally
                                         │
                              result table · Vega-Lite chart · SQL disclosure
```

One automatic repair round-trip on SQL error, then the failure is shown honestly
alongside both attempted statements.

### Why PapaParse *and* DuckDB

DuckDB does the real load — it is faster and its type inference is the point of
using it. But it does not reject a ragged CSV: it widens to the longest row,
discards the header, and names the columns `column0…column3`. A load that
"succeeds" into nonsense is worse than an error, because the user then asks
questions of it. PapaParse runs first purely to turn that into a sentence. Both
behaviours are pinned in `duck.test.ts`.

### Why the single-threaded DuckDB bundle

The multi-threaded build needs `SharedArrayBuffer`, which needs COOP/COEP
cross-origin isolation headers. `selectBundle()` only picks that build when the
page is already isolated, so shipping single-threaded costs nothing today. If the
50k-row responsiveness target is ever missed, the fix is a path-scoped `_headers`
rule for `/asksheet/*` only — the six sibling apps on the origin are separate
documents and are unaffected.

## Layout

```
src/
  lib/
    types.ts        shared shapes; imports nothing
    runtime.ts      the DI seam — see below
    duck.ts         DuckDB worker bootstrap, CSV registration, timeout, row cap
    profile.ts      schema profiling, sample and error redaction  ← the privacy boundary
    validate.ts     single-SELECT guard
    plan.ts         the ask loop with one-shot repair
    planClient.ts   the one outbound call
    chart.ts        Vega-Lite spec preparation and validation
    csv.ts          PapaParse preflight
    csvErrors.ts    parse and engine failures → sentences with a next step
    columnTypes.ts  the cast allowlist
    starters.ts     three questions from the schema alone
    exportCsv.ts    result → CSV download
  components/       Dropzone · SchemaChips · Answer · SqlDisclosure · Chart · PrivacyContract
  samples/          two bundled CSVs
test/
  duckdb-node-worker.cjs   Web Worker globals for the Node integration test
```

**The DI seam.** `profile.ts` and `plan.ts` carry the privacy logic, so neither is
allowed to import `duck.ts` (the WASM bundle) or `planClient.ts` (the network
client). They read a `QueryRunner` and a `Planner` out of `runtime.ts`, which
`bootstrap.ts` populates once from `main.tsx`. The payoff is that the two most
important files in the app are unit-testable in a bare Node process, with no WASM
binary and no network client anywhere in their module graph.

## Development

```bash
npm run dev   -w apps/asksheet     # needs VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run build -w apps/asksheet     # → apps/asksheet/dist, base '/asksheet/'
npx vitest run apps/asksheet       # 228 tests, including a real DuckDB
npm run test:functions             # the Deno side, including redact.test.ts
```

The DuckDB integration test boots the engine's Node bundle over
`node:worker_threads`. The published recipe adds the `web-worker` package for
this; `test/duckdb-node-worker.cjs` supplies the same three globals in fifteen
lines, so there is no test-only runtime dependency.

## Server side

One Edge Function, `supabase/functions/asksheet-plan`. It:

- rejects a body over 32 KB **before parsing it**, so an oversized "profile"
  cannot be used to smuggle rows;
- rebuilds the profile key by key server-side, because a server that trusts a
  client's promise about a privacy boundary is not enforcing one;
- re-runs the same allowlist redaction over `repair.error` (`redact.ts`), for
  exactly that reason — a stale or tampered tab must not be able to post a raw
  DuckDB error containing a cell;
- maps an OpenRouter failure to a 502 with a sentence, rather than letting the
  provider's raw body reach the browser as a 500;
- consumes `platform.consume_quota('asksheet', 'plans')` before spending a token —
  20 plans a day anonymous, 100 linked. **A repair round-trip is a second plan**,
  so a failed query costs two; the UI says so rather than letting the count
  surprise you;
- logs no question or profile content.

AskSheet owns **no Postgres schema and no storage**. There is nothing to store,
permanently and by design.

## Limits

- CSV and TSV only. XLSX is phase 2 (SheetJS).
- One file at a time; multi-file joins are phase 2.
- **Files are capped at 100 MB.** There is no server to hand a big file to — the
  bytes go into the JS heap, then the WASM heap, then a columnar table beside it,
  inside a 32-bit address space shared with the page. A 200 MB CSV does not fail
  politely at any of those steps, it takes the tab down, so it is refused with a
  sentence instead.
- Results are capped at 5,000 rows for display and 2,000 rows for charting.
- Queries time out after 10 seconds; schema sampling after 5, and it scans at most
  20,000 rows per column so profiling costs the same on a small sheet and a huge one.
- A browser without WebAssembly, Workers or BigInt is told so up front, before the
  dropzone is offered. There is no server-side fallback, by design.
- Reads only: `assertSingleSelect` rejects anything that is not a single SELECT or
  `WITH` query, and specifically rejects `read_csv`, `read_parquet`, `glob` and
  friends — the only SQL that could reach outside the tab.
