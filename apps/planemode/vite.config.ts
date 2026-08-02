import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { NAVIGATE_FALLBACK_DENYLIST, SW_SCOPE } from './src/sw-register'

/**
 * PlaneMode is served from `labs.abdash.net/planemode/`, one of seven apps on a
 * single origin. Every path in this file is qualified with that prefix on
 * purpose — see the comments on `scope` and `navigateFallbackDenylist`.
 */
export default defineConfig({
  base: '/planemode/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // Registration is done by hand in src/sw-register.ts so the scope is
      // asserted by a test rather than left to plugin defaults.
      injectRegister: null,
      // Scope and start_url must both be path-qualified, or install-to-homescreen
      // resolves to the origin root and the installed app opens the wrong page.
      // Shared with the runtime registration so the two can never drift apart.
      scope: SW_SCOPE,
      manifest: {
        name: 'PlaneMode',
        short_name: 'PlaneMode',
        description: 'A small AI model that runs entirely in your browser. Works with the network off.',
        start_url: '/planemode/',
        scope: '/planemode/',
        display: 'standalone',
        background_color: '#101014',
        theme_color: '#101014',
        icons: [
          { src: '/planemode/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/planemode/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/planemode/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Never precache model weights. They are gigabytes, WebLLM caches them
        // itself from the HuggingFace CDN, and Cloudflare Pages refuses files
        // over 25 MiB anyway. The glob is an allowlist of shell assets only.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/*.wasm', '**/*.bin', '**/*.params', '**/model*/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: '/planemode/index.html',
        // The second half of the scoping defence. Even if the worker were
        // somehow consulted for a sibling app's path, it refuses to answer:
        // anything that is not under /planemode/ falls through to the network.
        // Defined in src/sw-register.ts so a test can assert the shipped regex.
        navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
        cleanupOutdatedCaches: true,
        // Weights come from huggingface.co. Workbox must not try to route,
        // cache or otherwise involve itself in those requests.
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Cloudflare Pages rejects individual files over 25 MiB. Nothing in the
    // shell comes close, but the warning limit keeps that honest.
    chunkSizeWarningLimit: 4096,
  },
})
