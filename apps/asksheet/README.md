# AskSheet

Drop a CSV, ask questions in English, get answers with visible SQL and charts —
with the data never leaving the browser.

Deployed at `labs.abdash.net/asksheet`.

---

## Two paths

The app opens on **"See a finished example"** and the live product is one click
away. The split exists because AskSheet is an awkward thing to demo: the
expensive half is invisible.

|  | See a finished example (default) | Ask your own question |
| --- | --- | --- |
| Sample | bundled CSV, preloaded | your CSV, or either sample |
| The SQL | planned earlier, saved in the page | planned live |
| The numbers | computed in your tab, when you click | computed in your tab |
| Requests | **none** | one per question |
| Session | none — no account is created | anonymous account |
| Daily allowance | untouched | one question |

Everything on the example path except the SQL, the sentence above each table and
the chart spec is computed at the moment of the click, by the same DuckDB running
the live path. No number on screen is stored. Every answer says so, permanently,
rather than letting a reader assume the whole thing is a screenshot.

See [The finished example](#the-finished-example) for how the saved plans are
produced, and why none of them is hand-written.

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
3. Click **Ask your own question**, load the **SaaS revenue** sample and ask
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

### The stronger version, on the default path

Stay on **See a finished example** and click one of the three questions. The
Network panel does not move: **not one request**, not even the planner's.

Getting there took two changes beyond saving the SQL, both worth the trouble
because the alternative was a page that told a sceptic to open DevTools and then
showed them traffic:

- **No session.** `AuthGate` used to wrap the whole app, so a first-time visitor
  signed up for an anonymous account — a Turnstile script, a challenge and a
  `signInAnonymously` — before seeing anything. The example path spends no quota
  and calls nothing, so it needs no identity; the gate now sits around the live
  path only (`main.tsx`, and the note above the render in `App.tsx`). Reading the
  daily allowance moved inside the gate for the same reason.
- **The chart renderer is fetched at page load, not at the click.** Vega is
  code-split, so drawing the first chart would have put one same-origin chunk on
  the wire at exactly the moment being watched. `warmChartRenderer()` pulls it in
  while the visitor is still reading, and the live path keeps its lazy import.

So the whole of a first visit is: this page's HTML, JS and CSS; the DuckDB
engine and its worker from jsDelivr; the chart renderer. Then nothing, however
many of the three questions you click.

Now tick **Strict mode** in the privacy panel and ask another question. The
`samples` arrays in the next payload are all empty, and the conversation resets —
see below for why that is not an inconvenience but part of the claim.

For reference, a whole request against the 219-row bundled sample is **726
bytes**, of which the profile is 626. That is not an estimate: it is measured,
recorded in `src/example/fixture.json`, and readable in the app itself under
*"the 726 bytes that were sent to plan it"* on any example answer — the entire
payload, without opening DevTools at all.

The same check runs as an assertion in CI, at six levels:

| Level | File | What it pins |
| --- | --- | --- |
| Unit | `src/lib/profile.test.ts` | The emitted object has exactly the keys `columns`, `rowCount`, `table` — asserted **by exclusion**, so a future field cannot slip in |
| Loop | `src/lib/plan.test.ts` | A result is never forwarded to the planner, even across a repair round-trip |
| Engine | `src/lib/duck.test.ts` | Against a real DuckDB, no cell value appears anywhere in a strict-mode profile |
| Row | `src/lib/duck.test.ts` | Against the real bundled sample, **zero of 219 source rows** can be reconstructed from a normal-mode payload |
| Error | `src/lib/duck.test.ts`, `supabase/functions/asksheet-plan/redact.test.ts` | A real DuckDB conversion failure names the offending cell; the text that leaves does not contain it |
| Wire | `src/example/example.test.ts` | The same row-reconstruction and key-set properties, over **bytes that actually crossed** — the request bodies saved verbatim in `fixture.json`, rather than a payload synthesised by a test |

The last row is the one that needed no mocking. Everything above it reasons about
what the code would send; that one reads what it did send.

### Why the row and error levels exist

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

## The finished example

Three questions, captured against the deployed planner and replayed locally.

| # | Question | What it shows |
| --- | --- | --- |
| 1 | *Which month had the highest revenue and why is it an outlier?* | The headline this README promises. One row, one number, no chart. |
| 2 | *Now break that month down by plan and contract type* | A follow-up — and the answer to the first question's second half. |
| 3 | *Chart monthly revenue by region so I can see where the growth is* | A Vega-Lite line chart over 72 locally-computed rows. |

Question 2 is the interesting one twice over. "That month" resolves only from
question 1's SQL, so it demonstrates the thing about the design that is easiest
to miss — **what carries conversation context is prior SQL, never prior
results** — and the planner resolved it with a correlated subquery rather than by
being told the answer:

```sql
SELECT plan, contract_type, SUM(revenue_usd) AS total_revenue FROM data
WHERE month = (SELECT month FROM data GROUP BY month
               ORDER BY SUM(revenue_usd) DESC LIMIT 1)
GROUP BY plan, contract_type ORDER BY total_revenue DESC
```

It returns four rows, one of which is `Enterprise · annual_prepay · 851000`. That
is *why* 2025-03 is an outlier, which question 1 alone does not say: asked on its
own it produces a bare `ORDER BY … LIMIT 1`. Clicking question 2 first therefore
replays question 1 before it, because a follow-up shown alone is half a
conversation.

### Nothing in the fixture is hand-written

`scripts/capture-example.mjs` boots a real DuckDB, loads the real bundled CSV,
profiles it with the app's own `buildProfile`, and drives the app's own `ask()`
loop against the live Edge Function. `src/example/fixture.json` is exactly what
came back.

```bash
SUPABASE_ANON_KEY=... node apps/asksheet/scripts/capture-example.mjs
SUPABASE_ANON_KEY=... node apps/asksheet/scripts/capture-example.mjs --dry-run
```

It costs one unit of `asksheet:plans` per question, from a fresh anonymous
session — the same tier and the same ceiling a first-time visitor gets. A
question whose first statement fails spends two, exactly as it would in the
browser, and the fixture records that it did.

The app's TypeScript is loaded through a single Vite dev server rather than
`runnerImport` per module, which is where the sibling recorder in `apps/raglab`
differs: this script injects a planner into `runtime.ts` and then calls `ask()`
from `plan.ts`, and per-module imports would give each of them its own instance
of the registry, so the injection would silently do nothing.

**Results are not captured.** No number a visitor sees comes from the file. The
`observed` block records column names and row count at capture time so
`example.test.ts` can catch a fixture that has drifted from the sample; it is
never rendered.

**The privacy boundary is re-checked before anything is written.** The fixture
holds `request` — a verbatim copy of each body that crossed the network, shown in
the UI under *"the 726 bytes that were sent to plan it"* — so the recorder runs
the row-reconstruction property over it and refuses to write if a single source
row could be rebuilt from the samples it discloses. The same checks run again in
`example.test.ts`, this time against bytes that are already committed.

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
  components/       Dropzone · SchemaChips · Answer · SqlDisclosure · Chart
                    PrivacyContract · ExamplePanel · UpgradePrompt
  samples/          two bundled CSVs
  example/
    fixture.json    GENERATED — the three captured plans, verbatim
    index.ts        typed loader, prerequisite chain, provenance
scripts/
  capture-example.mjs      regenerates the fixture against the live planner
test/
  nodeDuck.ts              a real DuckDB under Node; used by the integration
                           suite and by the capture script
  duckdb-node-worker.cjs   Web Worker globals for that engine
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
npx vitest run apps/asksheet       # 259 tests, including two real DuckDBs
npm run test:functions             # the Deno side, including redact.test.ts

SUPABASE_ANON_KEY=... npm run capture:example -w apps/asksheet
```

The DuckDB integration tests boot the engine's Node bundle over
`node:worker_threads`. The published recipe adds the `web-worker` package for
this; `test/duckdb-node-worker.cjs` supplies the same three globals in fifteen
lines, so there is no test-only runtime dependency. `test/nodeDuck.ts` wraps that
into one `bootNodeDuck()` shared by `duck.test.ts`, `example/replay.test.ts` and
the capture script — the last of which is why it is a module rather than thirty
lines inside a test file.

`example/replay.test.ts` runs every saved statement against the real bundled CSV
and asserts it still returns the shape it returned when captured, that it returns
rows at all, that a spec survives `toChartSpec`, and that question 1 still names
`2025-03`. A finished example that has quietly stopped finishing is worse than no
example.

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
