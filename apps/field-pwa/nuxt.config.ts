// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@pinia/nuxt',
    '@vite-pwa/nuxt'
  ],

  devtools: {
    enabled: true
  },

  // Leaflet + markercluster stylesheets are loaded globally so map tiles,
  // controls, and cluster markers render correctly across all map views.
  css: [
    '~/assets/css/main.css',
    'leaflet/dist/leaflet.css',
    'leaflet.markercluster/dist/MarkerCluster.css',
    'leaflet.markercluster/dist/MarkerCluster.Default.css'
  ],

  // Forced Light Mode (mandatory steering requirement).
  // Dark mode is explicitly disabled for outdoor readability.
  colorMode: {
    preference: 'light',
    fallback: 'light'
  },

  routeRules: {
    '/': { prerender: true }
  },

  compatibilityDate: '2026-06-30',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // Progressive Web App configuration (@vite-pwa/nuxt).
  // Feature offline logic is wired in downstream Phase 12 tasks; this is baseline init only.
  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'KF Maction',
      short_name: 'Maction',
      description: 'KF Maction Field Force PWA',
      theme_color: '#1C4173',
      background_color: '#FFFFFF',
      display: 'standalone',
      start_url: '/',
      icons: [
        {
          src: 'pwa-192x192.png',
          sizes: '192x192',
          type: 'image/png'
        },
        {
          src: 'pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png'
        },
        {
          src: 'pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable'
        }
      ]
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
      navigateFallback: '/'
    },
    devOptions: {
      enabled: false
    }
  }
})
