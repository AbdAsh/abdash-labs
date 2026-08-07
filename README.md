# abdash labs

Seven AI applications sharing one account, one database and one deploy.

**Live at [labs.abdash.net](https://labs.abdash.net)** · Built by [Abdulrahman](https://abdash.net)

Each one proves a different thing about applied AI engineering — retrieval, realtime
voice, code generation, evaluation, structured extraction, on-device inference. None of
them is a wrapper around a chat completion.

---

## If you have 60 seconds

Pick one. Every app works **without signing up** — you get an anonymous account on first
paint, and each has a bundled sample so there is nothing to prepare.

| App | Do this | What to notice |
|---|---|---|
| **[Recto](https://labs.abdash.net/recto/)** | Open the sample notebook, ask *"what do these two documents disagree about?"* | The citation names **which document** and which page. Retrieval spans documents, not just chunks. |
| **[AskSheet](https://labs.abdash.net/asksheet/)** | **Open DevTools → Network first.** Load the sample, ask a question. | No request body contains a single row of your data. The privacy claim is verifiable in your own browser, not asserted in marketing copy. |
| **[Critiq](https://labs.abdash.net/critiq/)** | Paste a URL — try your own site | Scroll to **Answer-engine readiness**: can a model quote a correct, attributable claim from this page? Most SEO tools don't ask. |
| **[RAG Lab](https://labs.abdash.net/raglab/)** | Press *Run benchmark* on the bundled document | Open a question the winner **missed**. It tells you *why* — chunk too small, split across a boundary, or ranked #14 when k was 5. |
| **[GraphRead](https://labs.abdash.net/graphread/)** | Open the demo graph, click any **edge** | The verbatim sentence that justified that relationship. Every edge has one, or it was discarded. |
| **[PlaneMode](https://labs.abdash.net/planemode/)** | Install it, let the model download, **switch on airplane mode**, keep chatting | There is no server. There never was. |
| **[Concierge](https://abdash.net)** (on the AI tab) | Click *Interview my AI* and ask about my experience — then **interrupt it mid-sentence** | It stops talking and listens. Turn-taking and barge-in are hand-written, not rented from a voice platform. |

---

## What each one is for

**Recto** — multi-document notebooks with cited retrieval. Successor to
[ReadLLM](https://readllm.vercel.app), which is still live and deliberately unchanged: it
was an honest minimal NotebookLM whose own README listed no auth, one notebook, no
history, no OCR. Recto is what closing that list looks like. *Proves: RAG depth and
multi-tenant product engineering.*

**AskSheet** — ask a spreadsheet questions in English. DuckDB-WASM executes every query
in your browser; only column names, types and a few sample values ever reach a server.
*Proves: code-generating agents and client-side compute.*

**Critiq** — SEO and answer-engine review of any URL. Deterministic checks are
authoritative for mechanics; the model is credited only with judgment, and the two are
merged and deduplicated. *Proves: multimodal-adjacent analysis and domain judgment.*

**RAG Lab** — benchmark chunking, embedding and retrieval configurations against a
labelled question set. Everyone ships RAG; almost nobody shows measurement. *Proves:
evaluation rigour.*

**GraphRead** — a document becomes an entity graph where every node and edge traces back
to the passage that asserted it. *Proves: structured extraction with provenance.*

**PlaneMode** — a small language model running entirely in your browser over WebGPU. No
backend, no API key, no telemetry, works offline. *Proves: on-device inference.*

**Concierge** — a voice agent that has read my CV and answers questions about my
experience out loud. *Proves: realtime voice, built rather than configured.*

---

## For technical reviewers

The interesting material here is not that seven apps exist. It is what was found while
building them, and the shape of the platform underneath.

### One platform, seven tenants

One Supabase project hosts all seven, because the free tier allows two projects, not
seven. That constraint forced the isolation to be structural rather than conventional:

- **A Postgres schema per app**, plus a shared `platform` schema for identity and quotas.
- **RLS on every table**, `owner_id = auth.uid()`, all four verbs, `with check` on insert.
- **Edge Functions build their Supabase client from the caller's JWT**, never the service
  role. Isolation is enforced by Postgres, not by remembering to add a `where` clause.
  The service role appears in exactly two places, both of which have no caller to act as.
- **One anonymous session works across all seven apps**, because they share an origin.
  Single sign-on with no code.

`consume_quota` is `SECURITY DEFINER` yet invoked through the *caller's* client — that is
what lets it read their tier from their own JWT while touching counter tables the caller
has no grant on.

### Bugs worth reading about

Each of these survived a green test suite. They are in the commit history with the
reasoning attached; `git log` reads like a defect notebook.

**A payload whose shape was right and whose alignment leaked.** AskSheet promised "up to
five example values per column." It delivered exactly that — but a bare `limit 5` returned
each column in insertion order, so the *k*-th sample of every column came from the same
row, and five complete records were reconstructible. Correct shape, correct count, wrong
correspondence. Found by reading bytes in the network tab, not by a test.

**Then the fix leaked differently.** `order by 1` broke row alignment and substituted an
order statistic: the five *lowest* values of every column. Now `order by hash(v)` —
uncorrelated between columns, uncorrelated with value, and deterministic, because
re-sampling randomly on each turn would disclose fresh values every question.

**A check that could never fire.** Critiq's answer-engine readiness check keyed on
document-wide list items — but every site's navigation is `<li>`, so an eight-item menu
read as well-structured content. It could not fire on any page with a nav bar. Its tests
passed because they hand-set the count to zero, an input the real parser cannot produce.

**A verbatim quote supporting a claim it never made.** GraphRead validates that every
relationship carries a quote that appears in the source. But `"Helix Lab"` is a substring
of `"Helix Labs"`, so a truncation passed — and worse, a *complete, genuine* quote can be
stapled to an unrelated relationship and still check out. The gate now also requires the
quote to name one of the relationship's endpoints. The committed demo graph contained an
instance of the bug.

**Embeddings paired with the wrong text.** The shared embedding helper mapped the
provider's response by array position and discarded the per-item `index` the API returns
precisely because order is not guaranteed. A reordered response would have made Recto cite
the wrong passage in the correct format, RAG Lab crown the wrong configuration, and
GraphRead merge the wrong entities — with nothing anywhere able to notice.

**Four more that only a live database could show.** An index on `created_at::date` that
Postgres rejects outright (`STABLE`, not `IMMUTABLE`). A `service_role` with schema usage
but no table privileges. A trigger whose `CASE` referenced a column that does not exist on
one of its two tables, taking down every insert. And an RLS test harness that needed 34
anonymous sign-ins against a limit of 30 per hour, so it failed *differently* on every run.

### Verification

```
920 unit tests · 148 Deno tests · 5 cross-user isolation suites against a live database
```

The isolation suites are the ones that matter: they sign in as two separate people and
assert that neither can read, update or delete the other's rows — in every app schema, and
through retrieval, not just table reads. ReadLLM v1 shipped with a known IDOR. Here it is
not patched; it is unrepresentable.

---

## Running it yourself

```bash
npm install
npm run dev -w apps/recto     # or asksheet, critiq, raglab, graphread, planemode
npm test                      # unit tests, no credentials needed
```

Full setup — migrations, Edge Functions, secrets — is in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Architecture

```
Cloudflare Pages — one project, one origin: labs.abdash.net
  └─ /recto  /asksheet  /critiq  /raglab  /graphread  /planemode      (static SPAs)

Supabase
  ├─ Postgres + pgvector — platform · recto · raglab · graphread · critiq
  │    (asksheet and planemode own no schema; both persist nothing by design)
  ├─ Auth — anonymous · GitHub · Google · magic link
  └─ Edge Functions (Deno) → OpenRouter for chat, OpenAI for embeddings
```

Cloudflare serves static files and nothing else. Every server-side operation is a Supabase
Edge Function. OpenRouter has no embeddings endpoint, which is the entire reason OpenAI is
also in the stack.

```
apps/          the seven SPAs
packages/
  platform/    auth, session, quotas — the contract every app imports
  doc-core/    pdf.js extraction, chunking, RTL detection — shared by three apps
supabase/
  migrations/  one ordered history for all schemas
  functions/   nine Edge Functions, flat namespace, app-prefixed
```

## Licence

MIT.
