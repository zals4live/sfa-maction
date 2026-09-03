// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@pinia/nuxt'
  ],

  // SSR is enabled (Nuxt default) — the web-portal is a server-rendered desktop admin app,
  // giving fast first paint and SEO-neutral authenticated dashboards.
  ssr: true,

  devtools: {
    enabled: true
  },

  // Leaflet + markercluster stylesheets are loaded globally so map tiles,
  // controls, and cluster markers render correctly across all admin map views.
  css: [
    '~/assets/css/main.css',
    'leaflet/dist/leaflet.css',
    'leaflet.markercluster/dist/MarkerCluster.css',
    'leaflet.markercluster/dist/MarkerCluster.Default.css'
  ],

  // Forced Light Mode (mandatory steering requirement).
  // Dark mode is explicitly disabled for outdoor readability and a consistent admin UI.
  colorMode: {
    preference: 'light',
    fallback: 'light'
  },

  // Runtime configuration. `apiBase` is exposed to the client (public) so the centralized
  // API client resolves the Elysia backend URL from an env var — never a hardcoded secret.
  // Overridden at runtime by NUXT_PUBLIC_API_BASE (defaults to the relative `/api` proxy).
  runtimeConfig: {
    public: {
      // Consumed by the shared API client (mirrors field-pwa `public.apiBase`).
      apiBase: '/api'
    }
  },

  routeRules: {
    // Dashboard landing page is client-hydrated behind auth — no prerender.
    '/': { prerender: false }
  },

  compatibilityDate: '2026-06-30',

  // Dev-only proxy: forward `/api/**` from the Nuxt dev server to the Elysia backend so
  // browser calls stay same-origin (no CORS in dev). The upstream is read from an env var
  // (API_BASE_URL) and falls back to the local Elysia port. Production routing is handled
  // by Nginx, so this proxy is intentionally dev-scoped.
  nitro: {
    devProxy: {
      '/api': {
        target: `${process.env.API_BASE_URL ?? 'http://localhost:3000'}/api`,
        changeOrigin: true
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
