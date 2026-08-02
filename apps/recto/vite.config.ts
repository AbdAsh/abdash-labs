// `vitest/config` re-exports Vite's defineConfig with the `test` key added, so
// one file serves both the build and the unit tests.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/recto/', // required — the origin serves six apps by path
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
