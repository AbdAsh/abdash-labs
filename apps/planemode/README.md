# PlaneMode

A PWA that runs a small LLM entirely in the browser via WebGPU. Download it once, switch on
airplane mode, keep chatting.

**Live at [labs.abdash.net/planemode](https://labs.abdash.net/planemode/)**

## Try it in 30 seconds — well, more like ten minutes

This is the one demo that asks something of you: a model download of about 0.7 GB. There
is no way around it, and pretending otherwise would be the wrong product.

1. Open it. It checks your hardware and tells you the download size **before** you commit.
2. Let the model download. Close the tab halfway if you like — it resumes.
3. When it's ready, **turn on airplane mode**.
4. Keep chatting.

The badge that reads *Offline verified* only lights after a reply has been generated
start-to-finish with no network. It will not light on a warm-up generation, and it will
not light if connectivity returned mid-reply.

Needs a WebGPU-capable browser — recent Chrome or Edge. Anything else gets an honest
explainer rather than a broken page.

## What it proves

On-device inference, and the discipline to keep it that way. There is no account, no
telemetry, and no request to any server after the weights are cached — verifiable in your
own network tab.

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

## The first run is the product

A visitor is being asked to download most of a gigabyte before they see anything work. Every one of
these exists because it is a reason someone would otherwise close the tab.

- **The size is stated before the commitment**, on the landing copy, on every picker option and on
  the button itself.
- **Free space is checked first.** `detectCapability()` reports `freeBytes` from
  `navigator.storage.estimate()`, and `fitsInFreeSpace()` grades each tier `fits` / `tight` /
  `too-small` / `unknown`. A tier that cannot fit is called out and its button is disabled — 1.5 GB
  free and a 1.82 GB download is twenty minutes ending in a failure. `unknown` is a real answer:
  browsers that will not estimate get no guess made on their behalf.
- **Progress is per stage, and only one stage is called a download.** WebLLM runs fetch → load into
  GPU → compile shaders and restarts its `0..1` fraction for each, so a single bar wired to
  `report.progress` fills up three times. `parseLoadProgress()` reads WebLLM's own sentence into a
  named stage plus its own byte count. The middle stage reads from local disk; calling that a
  download would tell a returning visitor they are paying for the model twice.
- **Closing the tab at 60% is recoverable and says so.** The chosen tier is written to
  `localStorage` when the download *starts*, not when it finishes. On the next visit that trace is
  the difference between "Download 1.82 GB and start" — a lie — and "you started this before; it
  picks up where it stopped".
- **A finished download is never re-offered.** Boot probes the cache through the worker
  (`hasModelInCache`, no weights loaded) and, when the remembered tier is fully present, goes
  straight to loading it. That is the airplane test: reopen, and it is simply there.
- **A failure at 90% lands on a failure screen, not in the chat.** The previous code set the ready
  phase unconditionally after `loadModel`, so a dead download dropped the visitor into a composer
  that could not answer. Now the app has an explicit `failed` phase with *Try again* and *Choose a
  different model*.

## Runtime failure modes

| Situation | Behaviour |
| --- | --- |
| WebGPU present, `requestAdapter()` throws or returns null | Unsupported screen with the actual reason |
| Worker never boots (missing chunk, stale build) | `onerror` is turned into an error event, so the load promise settles instead of hanging on "Starting…" |
| First generation throws after a clean load | Warm-up failure routes to the `failed` screen — a model that cannot produce one token is not ready |
| GPU device lost / OOM mid-generation | Worker drops the engine so the retry is a genuine reload, and the UI offers *Reload the model* |
| Context window exceeded | Oldest turns trimmed with a visible notice, reset per reply |
| IndexedDB full or refused | Save failure is surfaced in the transcript; the reply still shows, the visitor is told it will not survive a reload |
| IndexedDB open fails once | The memoised connection promise is cleared, so the next call retries rather than the page never having history again |
| Stop pressed mid-token | Partial reply is kept; a stop before the first token cannot earn the offline badge |
| Two tabs open at once | A Web Lock decides. The second tab explains itself instead of taking the GPU down with both |

## Persistent storage and exclusivity

`src/lib/persist.ts` holds the two things this app asks the browser for before downloading a
gigabyte.

`navigator.storage.persist()` is requested in `loadModel()` **before** a single byte is fetched.
Without it the browser treats gigabytes of weights as evictable, and the next offline launch
silently finds nothing cached — the whole premise, quietly broken. `StorageManager.persist()` is
`[Exposed=Window]`, so it is called from the main thread rather than inside the engine worker, where
it does not exist.

`acquireEngineLock()` claims an exclusive Web Lock held for the lifetime of the page. Both fail
soft: a browser with neither still works, it is just less protected.

## The offline-verified badge earns it

`verified` is the demo's money moment, so it is the claim most worth attacking. A generation flips
it only after clearing every one of these:

1. the tracker was told the generation started (an unannounced or duplicated `done` proves nothing);
2. it started while offline;
3. it produced **at least one token** — a stop before the first token ends the request cleanly and
   generated no reply;
4. the connection did not return at any point in flight, tracked by an epoch counter rather than a
   flag, so a drop-reconnect-drop inside one generation is caught;
5. it was still offline when it finished.

The **warm-up generation deliberately does not count**. It runs automatically on every load, so
letting it verify would mean an offline reload lit the badge before the visitor typed anything —
true, but indistinguishable from a badge that is simply hard-coded. `run(..., track)` in
`lib/engine.ts` is what separates the two.

## Layout

```
src/
  sw-register.ts        scope-locked registration            (sw-register.test.ts)
  lib/hardware.ts       WebGPU, memory and free-space checks (hardware.test.ts)
  lib/tiers.ts          pinned builds, sizes, tier memory    (tiers.test.ts)
  lib/history.ts        IndexedDB, export, wipe              (history.test.ts)
  lib/offline.ts        offline-verified tracker             (offline.test.ts)
  lib/persist.ts        persistent storage + engine lock     (persist.test.ts)
  lib/engine-protocol.ts  worker contract, progress and error parsing (engine-protocol.test.ts)
  lib/engine.ts         main-thread proxy for the worker         (engine.test.ts)
  worker/engine.worker.ts the only file that imports @mlc-ai/web-llm
  components/           FirstRun · DownloadProgress · ModelPicker · StoragePanel · OfflineBadge · Unsupported
```

One deliberate split from the plan's file list: **`lib/engine-protocol.ts`**. It holds the worker
message contract *and* the two pure functions worth testing — `parseLoadProgress()` and
`describeEngineError()` — in a module free of any `@mlc-ai/web-llm` import, so `lib/engine.ts`, the
components and the tests can all use them without dragging the library into the main bundle.

A second split, `hooks/useOfflineVerified.ts`, has been **removed**. It was a nine-line
`useSyncExternalStore` binding with exactly one consumer and no test of its own, justified by
keeping `lib/offline.ts` React-free — which is true, and is unaffected by where the hook lives. It
now sits in `components/OfflineBadge.tsx`, the only file that ever called it.

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

- Run the airplane test literally on a mid-range laptop and record it. `Unsupported.tsx` has a
  `DEMO_VIDEO` constant, left `null` on purpose: a `<video>` pointing at a file that is not there
  yet renders a dead black rectangle on the one screen a visitor sees when nothing else works. Set
  it when the recording lands in `public/`.
- Deploy, then confirm in DevTools that the scope reads `/planemode/` and that loading `/recto/`
  shows **no** controlling service worker.
- Measure first token (< 5 s after load) and sustained throughput (>= 8 tok/s on the default tier).
- Phase 2: Translate and Summarize modes, iOS install polish.
