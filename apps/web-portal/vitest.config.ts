import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Minimal Vitest config for unit-testing framework-agnostic composables and
// presentational SFCs. The Vue plugin compiles `.vue` single-file components so
// they can be rendered in the node environment. Nuxt auto-import aliases are mapped
// so composables resolve against the project root during tests.
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
