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
  questions and the SQL they produced) and `question`. Nothing else.
- **No request carrying rows.** Not to `asksheet-plan`, not anywhere.

Now tick **Strict mode** in the privacy panel and ask another question. The
`samples` arrays in the next payload are all empty.

For reference, a full profile of the 219-row bundled sample is **711 bytes**, and
600 bytes in strict mode.

The same check runs as an assertion in CI, at four levels:

| Level | File | What it pins |
| --- | --- | --- |
| Unit | `src/lib/profile.test.ts` | The emitted object has exactly the keys `columns`, `rowCount`, `table` — asserted **by exclusion**, so a future field cannot slip in |
| Loop | `src/lib/plan.test.ts` | A result is never forwarded to the planner, even across a repair round-trip |
| Engine | `src/lib/duck.test.ts` | Against a real DuckDB, no cell value appears anywhere in a strict-mode profile |
| Row | `src/lib/duck.test.ts` | Against the real bundled sample, **zero of 219 source rows** can be reconstructed from a normal-mode payload |

### Why that last row exists

Counting disclosed values is the wrong measure. The right one is how many *records*
can be rebuilt from them, and the two came apart in practice.

Sampling each column with a bare `limit 5` returns values in insertion order, so
the k-th sample of every column came from the same source row. Five complete
records of the bundled sample were therefore reconstructible verbatim from the
outbound request — while every unit test passed, because each individual value was
legitimately disclosed and the payload shape was exactly as promised. It was only
visible by reading the bytes in DevTools.

The fix is `order by 1` in the sample query (`src/lib/profile.ts`): each column is
sorted independently, so the values remain real but no longer line up into rows.
The count is now zero and a test holds it there.

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
    profile.ts      schema profiling and redaction  ← the privacy boundary
    validate.ts     single-SELECT guard
    plan.ts         the ask loop with one-shot repair
    planClient.ts   the one outbound call
    chart.ts        Vega-Lite spec preparation and validation
    csv.ts          PapaParse preflight
    csvErrors.ts    parse problems → sentences
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
npx vitest run apps/asksheet       # 187 tests, including a real DuckDB
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
- consumes `platform.consume_quota('asksheet', 'plans')` before spending a token —
  20 plans a day anonymous, 100 linked;
- logs no question or profile content.

AskSheet owns **no Postgres schema and no storage**. There is nothing to store,
permanently and by design.

## Limits

- CSV and TSV only. XLSX is phase 2 (SheetJS).
- One file at a time; multi-file joins are phase 2.
- Results are capped at 5,000 rows for display and 2,000 rows for charting.
- Queries time out after 10 seconds.
- Reads only: `assertSingleSelect` rejects anything that is not a single SELECT or
  `WITH` query, and specifically rejects `read_csv`, `read_parquet`, `glob` and
  friends — the only SQL that could reach outside the tab.
