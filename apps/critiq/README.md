# Critiq

Paste a URL, get the SEO review a senior practitioner would write — including whether an
AI answer engine can actually cite you.

**Live at [labs.abdash.net/critiq](https://labs.abdash.net/critiq/)**

## Try it in 30 seconds

No signup.

1. Paste any URL. Your own site is the interesting one.
2. Scroll to **Answer-engine readiness**.
3. Then try a URL you know is a client-rendered SPA.

That third step is worth doing. Fetching raw HTML means a JavaScript-only page returns an
empty shell — and rather than treat that as a tool failure, Critiq reports it as a
**critical finding**, because a page whose content is invisible without JS has a real and
frequently unnoticed problem.

## What it proves

Domain judgment layered on deterministic analysis. Every SEO scanner checks whether a
title tag *exists*. None can tell you the title is generic, the H1 promises something the
body never delivers, or the page targets an intent it doesn't answer.

The answer-engine dimension is the more current half: as search shifts toward generated
answers, *"could a model quote a correct, self-contained, attributable claim from this
page?"* is a question practitioners are actively asking and almost no tool answers.

## How it works

```
browser → Edge Function critiq-review
            SSRF guard  →  fetch  →  deno-dom  →  digest
                                                    ├─ 23 deterministic checks
                                                    └─ OpenRouter, judgment only
                                            merge, dedupe, grade → slug
```

**Deterministic checks are authoritative for mechanics; the model is credited only with
judgment.** Every finding is labelled by source, and any model finding that duplicates a
check that already fired is dropped. The judge is also told which checks passed, so it
does not restate them.

No browser, no screenshots, no third-party service — which is why Critiq is the only app
here with no storage allocation at all.

## Engineering notes

**A check that could never fire.** `no-extractable-answers` keyed on document-wide list
items, but every site's navigation is `<li>`, so an eight-item menu registered as
well-structured content. It could not fire on any page with a nav bar — which is every
page. Its tests were green because they hand-set the count to zero, constructing an input
the real parser cannot produce. Now measured over main content only, excluding nav, header
and footer.

**The SSRF guard is mutation-tested.** This fetches attacker-supplied URLs from our
infrastructure, so it is the only thing between a submitted URL and the network. Beyond
the obvious private ranges it blocks carrier-grade NAT (`100.64.0.0/10`), IPv4-mapped IPv6
in both compact and expanded form, decimal and hex and short-form IPv4, cloud metadata
addresses, and revalidates every redirect hop against a freshly resolved IP. Then each
defence was disabled one at a time — 17 mutants, all killed. One initially survived,
revealing a branch that was unreachable dead code behind a misleadingly named variable.

**Noise was audited empirically, not by eye.** Realistic pages were built and run through
the checks. `jsonld-missing` fired on four of four well-built sites at medium severity —
the definition of a check that fires on everything. Demoted, along with
`canonical-missing` (now escalates only when there is an actual duplicate to consolidate)
and `redirect-chain` (was counting a bare `http→https` upgrade, which is what a correctly
configured site does).

**The empty state does not lie about coverage.** A clean report says "19 of 19 mechanical
checks passed" and lists them — deliberately *not* computed as catalogue-minus-failures.
A page with no images never had alt coverage checked, and claiming it passed would
overstate what was examined.

**Quota is consumed after URL validation, and after the cache check.** Validation opens no
socket, so typing `localhost` used to burn an anonymous visitor's entire daily allowance
on a request that never left the building.

## Honest limitations

- **No JavaScript rendering**, by design. Reported as a finding when it matters.
- No rank tracking, keyword volume or backlink data — those need paid data vendors.
  Critiq reviews a page; it does not report on a market.
- Single URL per run. Small same-origin crawls are phase 2.
- Report pages carry `noindex`, and OG tags for social sharing need prerendering that
  isn't built yet.
- Anonymous accounts get 1 review a day, 3 when linked. Resubmitting the same URL the
  same day is free — the cache is checked before quota.

## Local development

```bash
npm install
npm run dev -w apps/critiq
npx vitest run apps/critiq                                  # app
deno test --allow-net --allow-env supabase/functions/       # SSRF, digest, checks, merge
```
