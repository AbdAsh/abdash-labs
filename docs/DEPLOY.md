# Deploying abdash labs

Everything here targets one Supabase project and one Cloudflare Pages project. The order
matters in a few places, and those places are called out.

Four steps cannot be done from code and must be done in the Supabase dashboard. They are
marked **DASHBOARD**. Each one, when skipped, produces an error that looks like a bug in
the application, so they are listed first.

---

## The four dashboard steps

**1. Exposed schemas** — Settings → API → Exposed schemas

Add `platform`, `recto`, `critiq`, `raglab`, `graphread` alongside the defaults.

Skipping this gives `PGRST106: The schema must be one of the following: public,
graphql_public` on every query. Note that **Edge Functions are not exempt** — they use
`supabase-js`, which goes through PostgREST like the browser does, so even the health
check fails.

**2. Anonymous sign-ins** — Authentication → Sign In / Providers

Enable them. The entire auth model is anonymous-first; without this nothing works and the
error is `Anonymous sign-ins are disabled`.

**3. Turnstile** — Authentication → Bot and Abuse Protection

Enable **after** the RLS suites pass, not before. The suites call `signInAnonymously()`
with no captcha token, so turning this on first breaks all sixty tests for a reason
unrelated to what they are testing.

**4. OAuth and SMTP** — Authentication → Providers / Emails

GitHub and Google for identity linking; Resend SMTP for magic link. Only needed to test
the *linked* quota tier — everything works anonymously without them. Supabase's built-in
email allows two messages an hour and is explicitly not for production, so custom SMTP is
mandatory rather than optional.

---

## Migrations

```bash
npx supabase link --project-ref <ref>
npx supabase db push
```

Or apply `supabase/migrations/*.sql` in order through the Supabase MCP.

Confirm `pgvector` is at least 0.7.0 before applying `0002`, which declares
`halfvec(1536)` columns:

```sql
select default_version, installed_version from pg_extension_versions where name = 'vector';
```

## Edge Function secrets

```bash
npx supabase secrets set \
  OPENROUTER_API_KEY=... \
  OPENAI_API_KEY=... \
  MODEL_CHEAP=openai/gpt-4o-mini \
  MODEL_QUALITY=openai/gpt-4.1 \
  MODEL_VISION=openai/gpt-4.1
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically. OpenRouter has no embeddings endpoint, which is the only reason an OpenAI
key is also required — it is used for embeddings and nothing else, at $0.02 per million
tokens.

## Edge Functions

Nine functions, flat namespace, app-prefixed:

```
platform-health   recto-ingest    recto-chat    recto-audio-overview
asksheet-plan     critiq-review   raglab-embed  graphread-extract
concierge-turn
```

```bash
npx supabase functions deploy platform-health --no-verify-jwt
npx supabase functions deploy concierge-turn  --no-verify-jwt
npx supabase functions deploy recto-ingest recto-chat asksheet-plan \
    critiq-review raglab-embed graphread-extract
```

Two deploy with `--no-verify-jwt`, and both for the same reason: they have no
authenticated caller. `platform-health` is hit by a cron; `concierge-turn` serves visitors
to the portfolio site, who have no session on this origin. Both implement their own
protection — an origin check and a per-IP limit.

## Cloudflare Pages

One project, one origin, all six SPAs under path prefixes.

- Build command: `npm run build`
- Output directory: `dist`
- Custom domain: `labs.abdash.net`

Build-time variables:

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_TURNSTILE_SITE_KEY
```

`public/_redirects` carries a per-prefix SPA fallback so one app's client router can never
capture another's routes. `scripts/build-all.mjs` discovers `apps/*` automatically and
skips directories beginning with an underscore.

**Use the legacy anon key**, not a publishable `sb_...` key. The publishable format is not
a JWT and the Edge Functions reject it.

## Keeping the project awake

Free Supabase projects pause after a week of inactivity, and a paused project cannot wake
itself — so `pg_cron` cannot do this. `.github/workflows/keepalive.yml` pings
`platform-health` every three days from GitHub Actions, which is outside the project and
therefore able to.

## Verification

```bash
npm test                                                    # 920, no credentials needed
deno test --allow-net --allow-env supabase/functions/       # 148
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run test:rls     # 5 suites, live database
curl https://<ref>.supabase.co/functions/v1/platform-health # {"ok":true,...}
```

The RLS suites are the ones that matter — they sign in as two separate people and assert
neither can reach the other's rows, in every schema and through retrieval rather than only
table reads.

They cost **five anonymous sign-ins per run** against Supabase's IP-based limit
(Authentication → Rate Limits). If you see `Request rate limit reached`, the budget is
spent; wait rather than raising the limit, because that limit is a real abuse control and
the harness was already rewritten to fit inside it.

## Cost

A full manual test pass across all seven apps costs roughly **$0.20**. Steady-state spend
is bounded two ways: per-user daily quotas in `platform.quota_limits`, and cross-user
daily ceilings in `platform.global_limits` sized so that maxing every meter on the same
day costs about $0.68 — roughly the monthly budget. Both are table-driven, so tightening
after a real traffic week is an `UPDATE` rather than a deploy.
