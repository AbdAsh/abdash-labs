/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Every lab app is served from a path prefix on one Cloudflare Pages origin,
// which is what makes the Supabase session shared across all seven.
export default defineConfig({
  base: '/raglab/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false },
  test: {
    name: 'raglab',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
