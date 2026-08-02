# PlaneMode

A PWA that runs a small LLM entirely in the browser via WebGPU. Download it once, switch on
airplane mode, keep chatting.

Deployed at `labs.abdash.net/planemode/`.

## There is no backend

No Postgres schema, no Edge Function, no storage allocation, no quota, no LLM spend, no telemetry.
PlaneMode is a static bundle on Cloudflare Pages and nothing else.

**No login, ever.** The shared anonymous session exists on this origin, but nothing in this app
reads it. There is no `@labs/platform` import anywhere in `src/`, and the root is not wrapped in
`AuthGate`. An app whose thesis is "no server is involved" cannot ask you to sign in.

## Pinned model builds

Resolved by reading `prebuiltAppConfig.model_list` out of the published package.

| Tier    | Model id                                | Download | `vram_required_MB` | Context |
| ------- | --------------------------------------- | -------- | ------------------ | ------- |
| `small` | `Llama-3.2-1B-Instruct-q4f32_1-MLC`     | 0.70 GB  | 1128.82            | 4096    |
| `mid`   | `Llama-3.2-3B-Instruct-q4f32_1-MLC`     | 1.82 GB  | 2951.51            | 4096    |

- **`@mlc-ai/web-llm` version: `0.2.84`** (resolved 2026-08-01; latest on the registry at the time).
- Pinned **without a caret**. `model_lib` URLs embed the package version —
  `…/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Llama-3.2-1B-Instruct-q4f32_1_cs1k-webgpu.wasm`
  — so a minor bump changes the wasm URLs and invalidates every already-downloaded copy. Bumping is
  a deliberate act, not a `npm update` side effect.
- Download figures are the summed HuggingFace repo file sizes
  (`GET https://huggingface.co/api/models/mlc-ai/<id>?blobs=true`), not the VRAM figure. They are
  what `DownloadProgress` shows, because that is the number a visitor is actually waiting on.
- Both tiers are **`q4f32_1`, not `q4f16_1`**. The f16 builds are smaller and faster but require the
  WebGPU `shader-f16` feature. An app promising "it just works after one download" should not gate
  itself on an optional GPU feature. Switching to f16 is a future opt-in, not a default.
- Same model family for both tiers on purpose: one chat template, one tokenizer, one set of
  behaviours to reason about when a visitor switches tier.

### Weights come from the HuggingFace CDN, never self-hosted

WebLLM's default `prebuiltAppConfig` behaviour is correct here and is deliberately left alone.
Cloudflare Pages caps individual files at 25 MiB, so bundling multi-gigabyte weights is impossible
regardless of intent — and self-serving them would be worse: fifty downloads of the mid tier is
90 GB of transfer. The Workbox precache glob is an allowlist of shell assets
(`js,css,html,svg,png,woff2`) with an explicit ignore list for `wasm`/`bin`/`params`, so the service
worker never tries to precache a model.

## The service worker scope is the sharpest edge here

Seven apps share `labs.abdash.net`. A service worker registered at the origin root would control
every one of them and serve them PlaneMode's cached shell. Three layers guard against that:

1. `src/sw-register.ts` registers with an explicit `{ scope: '/planemode/' }`, and the constants are
   hard-coded rather than derived from `import.meta.env.BASE_URL` so a build misconfiguration cannot
   widen them. Asserted by `src/sw-register.test.ts`.
2. If the browser ever resolves a scope wider than `/planemode/` — a stray `Service-Worker-Allowed`
   header, say — the registration is torn down immediately and `registerServiceWorker()` returns
   `null`.
3. `navigateFallbackDenylist: [/^\/(?!planemode\/)/]` in `vite.config.ts`. Even if the worker were
   somehow consulted for a sibling path, it refuses to answer for it.

The PWA manifest path-qualifies **both** `start_url` and `scope` to `/planemode/`. Without that,
install-to-homescreen resolves to the origin root and the installed app opens the wrong page.

## Persistent storage

`navigator.storage.persist()` is requested in `loadModel()` **before** a single byte is fetched
(`src/lib/persist.ts`). Without it the browser treats gigabytes of weights as evictable, and the
next offline launch silently finds nothing cached — the whole premise, quietly broken.

`StorageManager.persist()` is `[Exposed=Window]`, so it is called from the main thread rather than
inside the engine worker, where it does not exist.

## Layout

```
src/
  sw-register.ts        scope-locked registration            (sw-register.test.ts)
  lib/hardware.ts       WebGPU + memory detection            (hardware.test.ts)
  lib/history.ts        IndexedDB, export, wipe              (history.test.ts)
  lib/offline.ts        offline-verified tracker             (offline.test.ts)
  lib/tiers.ts          the pinned model builds
  lib/engine.ts         main-thread proxy for the worker
  lib/engine-protocol.ts  worker message contract, web-llm free
  lib/persist.ts        navigator.storage.persist()
  worker/engine.worker.ts the only file that imports @mlc-ai/web-llm
  hooks/useOfflineVerified.ts  thin useSyncExternalStore binding
  components/           FirstRun · DownloadProgress · ModelPicker · StoragePanel · OfflineBadge · Unsupported
```

Two deliberate splits from the plan's file list, both to keep the required tests runnable without a
DOM or a renderer:

- `useOfflineVerified` lives in `hooks/`, not in `lib/offline.ts`. `lib/offline.ts` imports nothing
  from React, so `OfflineTracker` is tested directly.
- The worker message contract lives in `lib/engine-protocol.ts`, so `lib/engine.ts` and the UI never
  pull `@mlc-ai/web-llm` into the main bundle.

## Wipe really wipes

`wipeAll()` clears the conversation store **and** WebLLM's caches — `webllm/model`, `webllm/wasm`
and `webllm/config` — in both Cache Storage and IndexedDB, since which backend is in use depends on
the browser. Those three names are removed individually rather than sweeping the origin, because six
sibling apps keep their own offline shells in the same Cache Storage.

Conversations are kilobytes; the model is gigabytes. A wipe that skipped the weights would report
success while leaving 1.8 GB on disk.

## Tests

```
npx vitest run --root apps/planemode
```

`vitest.config.ts` is kept separate from `vite.config.ts` on purpose: the tests do not need
`vite-plugin-pwa`, and keeping them apart means a PWA-plugin problem cannot take the unit tests down
with it.

## Still to do

- Run the airplane test literally on a mid-range laptop and record it (the recording is the README
  centrepiece and `Unsupported.tsx` links it at `/planemode/airplane-test.mp4`).
- Deploy, then confirm in DevTools that the scope reads `/planemode/` and that loading `/recto/`
  shows **no** controlling service worker.
- Measure first token (< 5 s after load) and sustained throughput (>= 8 tok/s on the default tier).
- Phase 2: Translate and Summarize modes, iOS install polish.
