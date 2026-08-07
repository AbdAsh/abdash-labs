# Recto

Multi-document notebooks you can question, where every answer carries its sources —
built as an open book, and mirrored when the book reads right-to-left.

**Live at [labs.abdash.net/recto](https://labs.abdash.net/recto/)**

## Try it in 30 seconds

No signup. You get an anonymous account on first paint.

1. Create a notebook and drop in **two** PDFs.
2. Ask something only both documents can answer together — *"what do these disagree
   about?"* or *"summarise what each says about X."*
3. Look at the citations. Each names **which document** and which page.

That last part is the point. Most "chat with your PDF" tools cite a chunk; retrieval here
spans every document in the notebook and stays attributable across them.

If a document is in Arabic, the whole layout mirrors — sources move to the right,
conversation to the left. That is what recto and verso actually do in an Arabic book.

## What it proves

RAG depth and multi-tenant product engineering. The predecessor,
[ReadLLM](https://readllm.vercel.app), is still live and deliberately frozen — an honest
minimal NotebookLM whose own README listed its gaps: no auth, one notebook, no history,
no OCR, and a known IDOR. Recto is what closing that list looks like.

The pairing is the story. One is a weekend demo; the other is what happens when you take
its limitations seriously.

## How it works

```
browser                          Supabase Edge Functions
  pdf.js extract                   recto-ingest → OpenAI embeddings → halfvec(1536)
  chunk (1600/320)        ──────►  recto-chat   → match_chunks → OpenRouter, streamed
  SHA-256 content hash
```

Extraction and chunking happen in your browser; only text chunks are uploaded. Notebook
lists and conversation history are read straight through PostgREST under RLS — an Edge
Function exists only where a policy cannot express the logic.

**Isolation is structural.** `match_chunks` runs `security invoker` and is called with
your JWT, so RLS scopes retrieval automatically. There is no code path holding the
privilege to read another user's chunks — v1's IDOR is not patched here, it is
unrepresentable. Five cross-user isolation suites assert this against a live database,
including through retrieval rather than only table reads.

## Engineering notes

**Partial ingest used to be silently catastrophic.** A batch failing at 2 of 6 left a
document row that looked complete and answered questions — confidently, with correct
citations — from the first fifth of itself. Re-uploading was then refused by the unique
content hash, making it unrecoverable. Fixed at three layers: `status` gates
`indexing → ready`, `match_chunks` filters on it, and the client rolls back the half-built
row.

**`embedding` is `NOT NULL` on purpose.** A chunk with a null embedding is invisible to
every similarity search forever, so accepting one turns a bad API response into a document
that is permanently, silently half-searchable.

**RTL detection classifies by Unicode script, not block range.** The Arabic block
U+0600–U+06FF contains the Arabic-Indic digits, so a range test marks a table of Arabic
numerals as right-to-left. Turkish stays left-to-right because its diacritics are
`Script=Latin` — which matters, since Turkish is a target language for this product.

**The spread mirrors with CSS logical properties only.** `grep -niE 'left|right'` over the
stylesheet returns nothing. The two places that cannot use logical properties — a caret
and a drawer transform — are handled explicitly and commented.

## Honest limitations

- **Audio overviews and OCR are not built.** They are phase 2 and 3 in the spec. Today
  this is the product core: auth, notebooks, multi-document cited retrieval, history.
- A scanned PDF with no text layer will tell you it found no readable text rather than
  OCR it.
- No sharing, no collaboration, no teams. Single-user notebooks by design.
- Anonymous accounts are capped at 1 notebook, 3 documents and 20 messages a day. Linking
  GitHub or Google raises that to 3 / 10 / 200.

## Local development

```bash
npm install
npm run dev -w apps/recto      # http://localhost:5173
npx vitest run apps/recto packages/doc-core
```

Needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Chat and ingest additionally need
the Edge Functions deployed with `OPENROUTER_API_KEY` and `OPENAI_API_KEY` set.
