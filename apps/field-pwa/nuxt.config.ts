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
  // Disable the color-mode module entirely so no `.dark` class is ever applied — this also
  // prevents a stale `nuxt-color-mode: dark` value in localStorage from darkening the UI.
  ui: {
    colorMode: false
  },

  routeRules: {
    '/': { prerender: true }
  },

  // Runtime configuration. `apiBase` is exposed to the client (public) so the shared API
  // client (useApiClient) resolves the Elysia backend via a same-origin `/api` prefix.
  // Overridden at runtime by NUXT_PUBLIC_API_BASE.
  runtimeConfig: {
    public: {
      apiBase: '/api'
    }
  },

  // Dev-only proxy: forward `/api/**` from the Nuxt dev server to the Elysia backend so
  // browser calls stay same-origin (no CORS in dev). `prependPath: false` strips the `/api`
  // prefix because the backend mounts routes at the root (`/auth`, `/orders`, ...).
  // Production routing is handled by Nginx, so this proxy is intentionally dev-scoped.
  nitro: {
    devProxy: {
      '/api': {
        target: `${process.env.API_BASE_URL ?? 'http://localhost:3000'}`,
        changeOrigin: true,
        prependPath: false
      }
    }
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
      // Scope confines the PWA navigation context to the app origin root,
      // required for a reliable standalone install on Android/iOS.
      scope: '/',
      icons: [
        {
          src: 'pwa-192x192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any'
        },
        {
          src: 'pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any'
        },
        {
          // Dedicated maskable icon with safe-zone padding for Android
          // adaptive icons (must be designer-provided, see PWA_INSTALL_TEST.md).
          src: 'pwa-maskable-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable'
        }
      ]
    },
    workbox: {
      // Precache the full app shell: JS/CSS bundles, HTML entry, icons,
      // fonts, and the generated web manifest. Covers Leaflet marker images
      // (png/svg) and Nuxt UI font formats (woff/woff2/ttf/eot).
      globPatterns: [
        '**/*.{js,css,html,png,svg,ico,json,webmanifest,woff,woff2,ttf,eot}'
      ],
      navigateFallback: '/',
      // Stale-While-Revalidate for same-origin static assets (FR-PWA-02):
      // serve cached app shell instantly, refresh in the background.
      runtimeCaching: [
        {
          urlPattern: ({ sameOrigin, request }) =>
            sameOrigin
            && ['style', 'script', 'worker', 'font', 'image'].includes(request.destination),
          handler: 'StaleWhileRevalidate',
          options: {
            cacheName: 'maction-app-shell',
            expiration: {
              maxEntries: 200,
              maxAgeSeconds: 60 * 60 * 24 * 30
            }
          }
        }
      ]
    },
    devOptions: {
      enabled: false
    }
  }
})
