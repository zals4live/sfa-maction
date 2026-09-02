import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Minimal Vitest config for unit-testing framework-agnostic composables (e.g. the
// Dexie CRUD wrappers) and presentational SFCs. The Vue plugin compiles `.vue` single-file
// components so they can be rendered (via `vue/server-renderer`) in the node environment
// without a DOM. Nuxt auto-import aliases are mapped so composables that import `~~/database`
// resolve against the project root during tests.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts']
  },
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '@@': fileURLToPath(new URL('.', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '@': fileURLToPath(new URL('./app', import.meta.url))
    }
  }
})
