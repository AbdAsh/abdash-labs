import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Required — the origin serves every lab app from a path prefix.
  base: '/graphread/',
  plugins: [react()],
  test: {
    name: 'graphread',
    // The lib layer is pure TypeScript and must stay runnable without a DOM,
    // so the default environment is node. Component tests are out of scope:
    // react-force-graph-2d needs a real canvas/WebGL context.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
