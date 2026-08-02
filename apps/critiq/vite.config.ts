import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Required — the origin serves every lab app from a path prefix.
  base: '/critiq/',
  plugins: [react()],
  test: {
    name: 'critiq',
    // Everything worth testing here is pure: route parsing, grade formatting,
    // severity filtering. No DOM needed, so none is loaded.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
