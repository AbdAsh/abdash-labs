# concierge-turn

One turn of the voice concierge embedded on the AI tab of `abdash.net`.

The browser island lives in the **other** repo (`abdash.github.io`, at
`src/components/concierge/`) because it is embedded in the Astro site. This is
the only project in the program split across two repos.

## Contract

```
POST /functions/v1/concierge-turn
Origin: https://abdash.net           (required — any other origin is 403)

{ "history": [{ "role": "user" | "assistant", "content": string }],
  "question": string }

→ 200 text/event-stream
  data: "Abdulrahman "
  data: "is a senior frontend engineer."
  data: [DONE]
```

Each frame's payload is a JSON-encoded string, so newlines and quotes survive
the SSE framing. There are no citations in this project, so there is no `\f`
separator — the body is answer text and nothing else.

Errors come back as JSON: `{ "error": string }` with 400, 403, 405, 429 or 500.

## Why it is unauthenticated

A visitor to `abdash.net` has no Supabase session — that lives on the
`labs.abdash.net` origin. There is no caller JWT to verify and no user to charge
a quota to, so this function is deployed `--no-verify-jwt` and its abuse
controls are an origin lock plus a per-IP limit through `platform.rate_limits`.

This and `platform-health` are the only two legitimate `serviceClient()` call
sites in the program, for the same reason: neither has a caller to act as.

Visitor IPs are never stored. `_shared/ratelimit.ts` takes the first entry of
`x-forwarded-for`, salts and hashes it, and uses only the digest as the bucket
key.

## Limits

| Control | Value |
|---|---|
| Turns per IP per hour | 20 |
| Question length | 500 chars |
| History kept | last 12 messages, 1500 chars each |
| Answer length | 1200 chars, enforced by truncating the stream |
| Model | `MODEL_CHEAP` |

`chatStream` takes no `max_tokens`, so the answer ceiling is applied here by
cutting the stream rather than by trusting the model to be brief.

## Secrets

```bash
npx supabase secrets set CONCIERGE_IP_SALT="$(openssl rand -hex 32)"
```

Plus the shared `OPENROUTER_API_KEY` and `MODEL_CHEAP` from the platform setup.

`CONCIERGE_IP_SALT` is **required**. Without it the function throws rather than
starting, because an unsalted SHA-256 of an IPv4 address is reversible by brute
force in seconds — storing one would be storing the IP with extra steps.

## The dossier

`dossier.ts` is generated, not written. It is emitted by
`scripts/build-dossier.ts` in the site repo, which writes both the site copy
(`src/data/dossier.md`) and this one in a single run:

```bash
cd ../abdash.github.io && node --experimental-strip-types scripts/build-dossier.ts
```

Do not edit `dossier.ts` here — it is overwritten. It is what the agent will
claim about a real person, so changes belong at the source and should be read in
full before they ship.

## Deploy

```bash
npx supabase functions deploy concierge-turn --no-verify-jwt
```

**Status: not deployed.** No API keys exist in this environment, so nothing has
been deployed and no live verification has been done.

Before this goes anywhere near the AI tab, work through
`adversarial-prompts.md` — twenty prompts covering roleplay, prompt extraction,
out-of-scope requests, salary negotiation and fabrication traps, plus the
transport and rate-limit checks. It is currently unrun.

## Tests

```bash
deno test --allow-env supabase/functions/concierge-turn/ratelimit.test.ts
```

Covers the limiting policy, window rollover, per-IP isolation, and that the
bucket key never contains a plaintext address. The tests inject an in-memory
store, so they need no database and no service-role credentials.
