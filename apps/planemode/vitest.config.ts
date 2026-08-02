import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts. The build config loads
// vite-plugin-pwa; the tests do not need it, and keeping them apart means a
// PWA-plugin problem can never take the unit tests down with it.
export default defineConfig({
  test: {
    name: 'planemode',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
