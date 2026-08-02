# GraphRead

Feed it a document; it extracts the entities and relationships and renders them as an
interactive force-directed graph — **every node and edge traceable back to the source passage
that asserted it**.

Deployed at `labs.abdash.net/graphread`.

## The two ideas worth reading the code for

### 1. The quote gate — `src/lib/validate.ts`

Every relation the model returns must carry a `quote`. Before that relation can become an edge,
the quote is checked against the chunk it came from. **If it is not there, the relation is
dropped.** Never repaired, never softened, never shown. This is what makes provenance a guarantee
rather than a claim.

The gate has exactly one tolerance and it is deliberate:

- **Whitespace is normalised on both sides.** PDF extraction sprays line breaks and double spaces
  through sentences, and no model reproduces those faithfully. Rejecting on whitespace would drop
  almost everything true.
- **Nothing else is tolerated.** Not case, not a dropped letter, not an inserted article, not a
  `co-` prefix on the verb. `"Dr. Sara Chen"` is rejected against a source that says
  `"Dr. Sarah Chen"`. Word-level fuzziness is precisely where a fabricated citation would hide.
- **The match must not cut a word in half.** `"Helix Lab"` sliced out of `"Helix Labs"` is a
  character substring but asserts something the document does not, so both ends of the match have
  to be flanked by non-word characters. A quote may still stop short of punctuation the model
  chose not to copy.
- **A quote under three words is dropped as unsupportive.** A bare verb matches half the document
  and proves nothing.

The gate runs inside `assemble()`, not upstream of it, so there is no code path that produces an
edge from an unverified relation. The drop count is surfaced in the UI whether or not it is
flattering.

### 2. The type gate — `src/lib/resolve.ts`

Resolution runs in two passes: a free deterministic one on normalized names, then an embedding
pass through the shared `raglab-embed` proxy. Both are bucketed by entity type, and **nothing
crosses a bucket**.

"Helix Labs" the organization and "Helix" the artifact read as near-identical to any embedding
model. Collapsing a company into its product is the most embarrassing failure this tool has, so
similarity is never allowed to overrule a type disagreement — not at 0.9, not at 1.0. The demo
graph ships with exactly that pair in it, visibly separate.

Merging uses union-find, so alias chains resolve transitively: if A matches B and B matches C, all
three are one entity even where A and C never clear the threshold directly.

The default threshold is 0.86, which is high. Two unrelated person names already sit around 0.75
with `text-embedding-3-small`, so a permissive threshold fuses a document's whole cast into one
blob. Over-splitting is recoverable with the merge correction; over-merging destroys information
silently.

## Shared code, not copied code

- Chunking is `chunkPages` from **`@labs/doc-core`** — the same code Recto and RAG Lab use, asked
  for a coarser 2500-char chunk through its existing `maxChars` parameter. GraphRead owns no
  chunker.
- Resolution pass 2 calls **`raglab-embed`**, RAG Lab's Edge Function. GraphRead has no embedding
  proxy of its own.

## Layout

```
src/lib/
  validate.ts     the quote gate + the extraction contract types
  resolve.ts      normalizeName, lexicalPass, embeddingPass, mergeNodes
  embed.ts        the raglab-embed client (the only network call outside extract.ts)
  graph.ts        assemble() — endpoint resolution, edge collapsing, provenance
  corrections.ts  applyCorrections() — merge and split, order-independent and idempotent
  extract.ts      the pipeline: file → pages → chunks → graphread-extract → graph
  cost.ts         the pre-run estimate
  persist.ts      permalinks in graphread.graphs
src/components/   GraphView, NodePanel, EdgePanel, Filters
src/demo/         the committed demo graph and the source it was built from
```

## The demo graph

`src/demo/demo-graph.json` is committed, so the card demo opens instantly and costs nothing.

`src/demo/source.json` holds the passages it was built from and the extraction JSON, because
provenance is the point — clicking an edge in the demo has to show you the passage, and that
passage has to exist. `demo.test.ts` re-derives the graph through the real `lexicalPass` and
`assemble`, asserts it byte-matches the committed file, and re-runs the quote gate over every
relation. Regenerate with `UPDATE_DEMO=1 npx vitest run apps/graphread/src/demo`.

**The demo text is original, written for this repo, not a public-domain work.** The plan called
for a public-domain text; a synthetic one was used instead so that every quote is verifiable
byte-for-byte with no risk of a misremembered citation, and so the type-gate pair (Helix Labs the
company, Helix the sequencer) is actually present to look at. Ten nodes, 21 edges, 7.9 KB.

## Cost

`estimateCost` is shown before any extraction runs. At `MODEL_CHEAP` rates
($0.15/M in, $0.60/M out) with ~2500-char chunks:

| Document | Chunks | Est. cost |
| -------- | ------ | --------- |
| 10 pages | ~10    | < $0.01   |
| 40 pages | ~40    | ~$0.02    |
| 60 pages (cap) | ~60 | ~$0.03 |

Two meters bound the spend. `graphread:extractions` (1/day anon, 5 linked) is the per-document
allowance, charged once on the first chunk. `graphread:chunks` (80 anon, 400 linked, seeded in
`0005_graphread.sql`) is charged on **every** call — so a client that misreports its chunk index
to dodge the document charge still hits a hard ceiling. The page cap is 60.

## Status

Tests: **97 passing** across `validate`, `resolve`, `graph`, `corrections`, `cost` and `demo`.
Typecheck and lint clean. `vite build` produces a working `/graphread/` bundle with no key in it.

Not yet done, and why:

- **Migration `0005_graphread.sql` is not applied.** Supabase is not authenticated in this
  environment.
- **`graphread-extract` is not deployed**, for the same reason. It has never been executed against
  a live model.
- **`tests/rls/graphread.test.ts` has not been run.** It needs `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` against a project with 0001 and 0005 applied.
- **The 30-edge quote audit and the 40-page duplicate-rate audit are not done.** Both require real
  extraction runs against a live model. The gate guarantees 100% of rendered edges are
  quote-validated by construction; what the audit measures is the softer question of whether the
  quote genuinely *supports* the relation, and that needs human reading of real output.
- **The 60fps drag check is not done.** It needs a browser and a mid-range laptop.
- **Component rendering is untested.** `react-force-graph-2d` needs a real canvas; the lib layer
  is pure and carries the whole test suite instead.
