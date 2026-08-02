# abdash labs

One monorepo, one Cloudflare Pages origin, one Supabase project, one login — hosting
seven AI demos that share a platform layer instead of reimplementing it seven times.

Live at **https://labs.abdash.net**.

## Architecture

```
Cloudflare Pages — one project, one origin: labs.abdash.net
  └─ /recto  /asksheet  /critiq  /raglab  /graphread  /planemode      (static SPAs)

Supabase
  ├─ Postgres + pgvector
  │    platform · recto · raglab · graphread · critiq schemas
  │    (asksheet and planemode own no schema — both persist nothing by design)
  ├─ Auth: anonymous · GitHub · Google · magic link (Resend SMTP on abdash.net)
  ├─ Storage: private per-app buckets
  └─ Edge Functions (Deno)
        ├─ OpenRouter  → chat · vision · structured extraction
        └─ OpenAI      → embeddings
```

The voice concierge is the one exception: it is an embedded island in the portfolio
site at `abdash.net`, not a standalone SPA. Its backend is still a Supabase Edge
Function, called cross-origin.

### Why one origin

Supabase persists sessions in `localStorage`, which is per-origin. Seven subdomains
would mean seven logins unless someone wrote and maintained a cookie-storage adapter
scoped to `.abdash.net`. Serving every app from a path under one origin makes SSO
structural: one anonymous session, one linked identity, seven demos, and no auth code
that can get it wrong.

## Layout

```
apps/{recto,asksheet,critiq,raglab,graphread,planemode}/   # Vite + React + TS SPAs
apps/_shell/                    # origin landing page (plain HTML, not a workspace)
packages/platform/              # THE CONTRACT — supabase client, session, AuthGate, quotas
packages/doc-core/              # pdf.js extraction, chunkers  (recto · raglab · graphread)
packages/ui/                    # design tokens, primitives
supabase/functions/             # flat, app-prefixed, with _shared/
supabase/migrations/            # ONE ordered history for every schema
tests/rls/                      # cross-user isolation harness
```

Seven repositories writing migrations into one shared database would drift within
weeks. A single ordered migration history is the argument that decided the monorepo;
the shared packages are the dividend.

## Hard rules

These are not style preferences. Breaking one breaks something real.

1. **Cloudflare Pages is static hosting only.** No Workers, no Pages Functions. Every
   server-side operation is a Supabase Edge Function.
2. **LLM calls go to OpenRouter. Embeddings go to OpenAI.** OpenRouter has no
   embeddings endpoint — that is the whole reason both are in the stack.
3. **No API key ever reaches a client bundle.** Keys are Edge Function secrets only.
   Anything `VITE_`-prefixed is public by construction.
4. **Edge Functions use the caller's JWT, never the service role.** Isolation is
   enforced by Postgres, not by remembering a `where` clause. `serviceClient()` is
   legitimate in exactly two places, both of which have no caller to act as:
   `platform-health` (cron target) and `concierge-turn`'s per-IP rate limiter.
   Quota enforcement does **not** need it — `consume_quota` is `SECURITY DEFINER`, so
   it elevates inside Postgres while still being invoked through the caller's client,
   which is what lets it read their tier from their own JWT.
5. **RLS on every table**, `owner_id = auth.uid()` for select/insert/update/delete,
   plus `with check` on insert. No exceptions, and it is proven by `tests/rls/`.
6. **Edge Functions share one flat namespace**, so every name is app-prefixed:
   `platform-health`, `recto-ingest`, `recto-chat`, `recto-audio-overview`,
   `asksheet-plan`, `critiq-review`, `raglab-embed`, `graphread-extract`,
   `concierge-turn`.
7. **Model IDs are never hardcoded** — read `MODEL_CHEAP`, `MODEL_QUALITY`,
   `MODEL_VISION` from env.
8. **Every app builds with `base: '/<app>/'`** and gets its own SPA fallback in
   `public/_redirects`, scoped to its prefix so no app's router can capture another's
   routes.

## Running locally

```bash
npm install
npm run dev -w apps/recto
```

Create `.env.local` in the app you are running:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_TURNSTILE_SITE_KEY=...
```

Repo-wide checks, all of which CI runs on every push:

```bash
npm run lint         # oxlint
npm run typecheck    # tsc -b
npm test             # vitest
npm run build        # every app into dist/<app>/, plus the shell and _redirects
```

The RLS suite talks to the live project and is opt-in:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... npx vitest run tests/rls/
```

## Adding a migration

One ordered history, shared by every app. Numbers are assigned, never guessed —
`0001_platform.sql` is the shared layer, and each app owns exactly one number.

```bash
npx supabase db push
```

Then add the new schema to **Settings → API → Exposed schemas** in the dashboard.
Skipping that is the cause of `PGRST106` on every query against it.

## Deploying a function

```bash
npx supabase functions deploy <name>
npx supabase functions deploy platform-health --no-verify-jwt   # unauthenticated
```

Secrets are set once and shared by all functions:

```bash
npx supabase secrets set \
  OPENROUTER_API_KEY=... OPENAI_API_KEY=... \
  MODEL_CHEAP=... MODEL_QUALITY=... MODEL_VISION=...
```

## Keeping the lights on

Free Supabase projects pause after a week idle, and a paused project cannot wake
itself — so `pg_cron` is not an option and the ping has to come from outside.
`.github/workflows/keepalive.yml` hits `platform-health` every three days. One cron
covers all seven apps.
