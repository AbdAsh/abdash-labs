# GraphRead

Feed it a document; it extracts the entities and relationships and renders them as an
interactive force-directed graph — **every node and edge traceable back to the source passage
that asserted it**.

Deployed at `labs.abdash.net/graphread`.

## The two ideas worth reading the code for

### 1. The quote gate — `src/lib/validate.ts`

Every relation the model returns must carry a `quote`, and that quote has to pass **two**
independent tests before the relation can become an edge. Failing either one drops it. Never
repaired, never softened, never shown. This is what makes provenance a guarantee rather than a
claim.

**Test one: is the quote real?** It is checked verbatim against the chunk it came from.

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

**Test two: is the quote about this relation?** The first test alone has a hole big enough to walk
through, and it is the more dangerous of the two because what comes out the other side looks
*more* trustworthy, not less. A model can copy a genuine sentence and staple it to a claim the
sentence never made — cite `"Dr. Sarah Chen founded Helix Labs"` in support of `Marcus Webb
founded Rotterdam` and every character checks out. So the quote must also **name at least one of
the relation's two endpoints**, whole-word, with honorifics and punctuation folded.

One endpoint, not both, and that is calibration rather than laziness: entity names vary between
passages, which is the entire reason the resolver exists. Demanding both would throw away
`"Chen founded Helix Labs"` whenever the model named the entity `Dr. Sarah Chen`. Demanding one
still rules out a quote that is about something else entirely.

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
  validate.ts     the quote gate, normalizeName, the extraction contract types
  resolve.ts      lexicalPass, embeddingPass, mergeNodes
  embed.ts        the raglab-embed client (the only network call outside extract.ts)
  errors.ts       unwraps Edge Function errors; say() for every catch site
  graph.ts        assemble() — endpoint resolution, edge collapsing, provenance
  corrections.ts  applyCorrections() — merge and split, order-independent and idempotent
  extract.ts      the pipeline: file → pages → chunks → graphread-extract → graph
  cost.ts         the pre-run estimate
  persist.ts      permalinks in graphread.graphs
src/components/   GraphView, NodePanel, EdgePanel, Filters
src/demo/         the committed demo graph and the source it was built from
```

`normalizeName` lives in `validate.ts` rather than `resolve.ts` because the gate and the resolver
have to agree on what counts as the same name, and only one module can own that rule. The gate is
the lower layer, so it owns it; `resolve.ts` re-exports it for callers who expect it there.

## When the run goes wrong

None of this had ever met a real model, so the failure paths got as much attention as the happy
one. `src/lib/extract.test.ts` drives all of it against a mocked function.

- **A chunk fails.** The other twenty-nine still build a graph. `stats.chunks` keeps counting the
  document, not the part of it that worked, and the UI says "this graph covers 29 of 30 passages".
  A silently partial graph is a dishonest one.
- **The allowance runs out.** On the first chunk it throws before spending anything else — which
  is why chunk 0 goes alone. Mid-run the workers stop rather than collecting thirty more refusals.
  This only works because `errors.ts` unwraps the response body: supabase-js reports every non-2xx
  as the same opaque `"Edge Function returned a non-2xx status code"`, so a 429 is invisible until
  you read `error.context`.
- **The user stops it.** An `AbortController` ends the run and keeps what was read.
- **Nothing comes back at all.** The graph goes empty and says so. It never falls back to showing
  the demo graph under the user's document name.
- **A chunk yields no entities, or an entity is in no relation.** Both are ordinary. Orphan nodes
  stay in the graph — the document named them, and that is information.
- **A permalink no longer resolves.** It says so, rather than quietly showing the demo as though
  it were the graph the link asked for.

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

The demo was also the first thing the anchored gate caught. One relation —
`Orbit Biosciences —competed with→ Helix Labs` — was quoted as *"For four years the two companies
competed for the same grants"*, which is verbatim in the passage and names neither company. The
sentence was rewritten to name them. A demo that cannot pass its own gate is not a demo.

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

## Permalinks

A saved graph is one row in `graphread.graphs`: nodes, edges, stats, the chunk-to-page map and the
correction list together, so opening a link is a single fetch.

There is **no public select policy on the table**, deliberately. `for select using (true)` would
open the permalink and also grant the whole table, because RLS cannot see that the client filtered
by slug — anyone could list every document every user has ever graphed, with owner ids. Reads go
through `graphread.graph_by_slug(text)`, a `security definer` accessor that puts the filter inside
the security boundary and never returns `owner_id`.

The one thing it says about ownership is `is_owner`, and it only ever tells you about yourself.
The client needs it because writes still go to the table under the owner policy: without it the
app would show merge and split controls to a stranger and then swallow every save as a zero-row
update that reports no error. A viewer of someone else's graph is told their corrections stay on
their device.

`revoke all … from public` precedes the grant, because `create function` grants EXECUTE to PUBLIC
by default and an accessor that is the sole gate on a table should name its callers.

## Status

Tests: **137 passing** across `validate`, `resolve`, `graph`, `corrections`, `extract`, `errors`,
`cost` and `demo`. Typecheck and lint clean. `vite build` produces a working `/graphread/` bundle
with no key in it.

Not yet done, and why:

- **Migration `0005_graphread.sql` is not applied.** Supabase is not authenticated in this
  environment.
- **`graphread-extract` is not deployed**, for the same reason. It has never been executed against
  a live model.
- **`tests/rls/graphread.test.ts` has not been run.** It needs `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` against a project with 0001 and 0005 applied.
- **The 30-edge quote audit and the 40-page duplicate-rate audit are not done.** Both require real
  extraction runs against a live model. The gate guarantees 100% of rendered edges are
  quote-validated *and* anchored to an endpoint by construction; what the audit measures is the
  softer remainder — whether the quote genuinely *supports* the relation — and that needs human
  reading of real output.
- **The 60fps drag check is not done.** It needs a browser and a mid-range laptop. What has been
  done is the arithmetic: `assemble` builds a 400-entity graph in well under a second (asserted in
  `graph.test.ts`), simulation nodes are reused across renders so a chunk landing does not restart
  the layout, labels are budgeted above 120 visible nodes, and the view zooms to fit when the
  engine settles.
- **Component rendering is untested.** `react-force-graph-2d` needs a real canvas; the lib layer
  is pure and carries the whole test suite instead.
