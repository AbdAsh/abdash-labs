# RAG Lab

Which chunking actually wins? Benchmarks, not vibes.

**Live at [labs.abdash.net/raglab](https://labs.abdash.net/raglab/)**

## Try it in 30 seconds

No signup, nothing to upload — a public-domain document ships with fifteen hand-labelled
questions.

1. Press **Run benchmark**.
2. Read the leaderboard.
3. Now open a question the winning configuration **missed**, and read the drill-down.

Step three is the product. A score tells you a configuration lost; the drill-down tells
you *why*, and the three reasons need different fixes:

- **impossible** — the chunk size cannot physically hold the answer
- **boundary** — the chunker split the answer; best coverage was 38%
- **depth** — it ranked #14 of 60, and k was 5. At k=14 this scores 0.07

## What it proves

Evaluation rigour. Everyone ships RAG; almost nobody shows measurement. This makes the
invisible choices — chunk size, overlap, strategy, embedding model, top-k — visible and
quantified, and produces a permalink anyone can open.

It also closes a loop: Recto chunks at 1600/320 because its predecessor did. RAG Lab
benchmarks that against the alternatives, and the winner becomes Recto's documented
default with the permalink cited as evidence.

## The idea that makes it work

A gold answer is stored as a **character span in the document**, not as a chunk. A
retrieved chunk counts as a hit if it overlaps that span by at least 50%.

That is the whole design problem solved in one decision. Grade each chunker against its
own boundaries and the numbers are not comparable to each other; grade everything against
spans in the source text and they are.

## Two structural constraints

**No embedding vector is ever written to Postgres.** A twelve-configuration run over a
hundred-page document is roughly 3,600 embeddings — about 11 MB — so forty-five saved runs
would consume the entire 500 MB database that all seven apps share. Vectors live in
IndexedDB; the server stores configuration, questions, gold spans and metrics.

This is enforced by a database trigger rather than trusting the client, because
`pg_column_size` is not `IMMUTABLE` and a `CHECK` constraint cannot express it.

**Runs are reproducible.** Identical inputs reproduce identical scores, which is a stated
success criterion and a surprisingly easy thing to break.

## Engineering notes

**The dangerous cache collision is the inverse of the obvious one.** Two configurations
cannot collide on one key — the key is injective. But two configurations can produce
*identical chunkings* under *different* keys, which happens whenever overlap does nothing
because every paragraph already fits, or when the recursive chunker meets unparagraphed
text. You buy the same embeddings twice and the leaderboard shows a **fake dead heat**
between configurations that are secretly the same. Detected by memoising on actual chunk
boundaries; twin rows are labelled.

**Float32 nearly broke determinism.** The cache stores float32, so a cache *miss* scoring
in float64 could rank a near-tie differently from a cache *hit*. Scores are now quantised
on the fresh path too, making warm and cold runs bit-identical.

**Gold spans drift silently.** Out-of-range offsets were caught; *in-range* drift was not.
Re-upload a lightly edited document and the offsets stay valid while pointing at a
different sentence — the run completes and scores a passage nobody labelled. Now detected
before spending, because questions carry their passage text.

**Some questions are arithmetically unhittable**, and it is better to say so before the
run than after. Every chunker emits chunks no larger than `size`, so a hit is impossible
when `size < threshold × goldLength`. The check is float-safe: `0.7 * 100` is
`70.00000000000001`, which would otherwise declare a reachable question impossible.

**The trigger that enforced the vector ban had a bug that blocked all writes.** It chose
its column with a `CASE` over the trigger argument, and PL/pgSQL resolves field references
in both branches — so `new.results` was looked up on a table that has no such column, and
every experiment insert failed. Invisible until real SQL ran against real Postgres.

## Honest limitations

- **Retrieval only.** Generation metrics — faithfulness, citation precision via an LLM
  judge — are phase 2, deliberately, because they are subjective and expensive.
- Documents capped near 100 pages, configurations capped at 12 per run. Exceeding the cap
  raises an error rather than silently truncating the matrix.
- Question suggestion is a heuristic passage finder, not a model. The Edge Function
  namespace is fixed at nine across the platform, so adding a tenth for suggestions was
  out of scope; the interface takes a pluggable suggester and wiring a model is a
  one-argument change.
- Permalinks are public by design, disclosed before saving. A local-only toggle skips
  persistence entirely.
- Anonymous accounts get 2 runs a day, 10 when linked.

## Local development

```bash
npm install
npm run dev -w apps/raglab
npx vitest run apps/raglab
```

The metrics suite is the one worth reading: it pins the half-open range boundary (a chunk
ending exactly at `gold.start` scores 0) and the exact threshold (50% hits, 49% does not).
Those two off-by-ones would quietly corrupt every score in the app.
