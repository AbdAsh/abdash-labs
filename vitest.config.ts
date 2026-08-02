import { defineConfig } from 'vitest/config'

// `npm test` runs UNIT tests only — the suites that need no credentials and no
// Deno runtime, so a clean checkout goes green with nothing but `npm install`.
//
// Two suite families are deliberately excluded and have their own scripts:
//   supabase/functions/**  → Deno tests (jsr: imports, Deno globals). `npm run test:functions`
//   tests/rls/**           → need a live Supabase project + credentials. `npm run test:rls`
// Sweeping either into the default run makes CI red for environmental reasons,
// which trains everyone to ignore a red CI.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    exclude: ['**/node_modules/**', '**/dist/**', 'supabase/**', 'tests/rls/**'],
  },
})
