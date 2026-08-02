import { defineConfig } from 'vitest/config'

// Cross-user isolation suites. These run against a LIVE Supabase project and
// prove that no user can read, update or delete another user's row in any app
// schema — the claim the whole platform rests on, verified rather than asserted.
//
// Requires SUPABASE_URL and SUPABASE_ANON_KEY, and a project with every
// migration applied. Deliberately separate from `npm test` so a developer
// without credentials still gets a green unit run.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run test:rls
export default defineConfig({
  test: {
    include: ['tests/rls/**/*.test.ts'],
    // Anonymous sign-ups and quota counters are shared state; parallel files
    // would race on the same daily counter rows and produce flaky failures.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
