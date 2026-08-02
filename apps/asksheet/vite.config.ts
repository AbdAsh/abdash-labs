import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Every app on labs.abdash.net is served from its own path prefix.
  base: '/asksheet/',
  plugins: [react()],
  // duckdb-wasm ships its own workers and .wasm assets; pre-bundling mangles the
  // worker URLs that `getJsDelivrBundles()` hands back.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
  },
})
