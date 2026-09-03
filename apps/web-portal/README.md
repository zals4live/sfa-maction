# web-portal

Nuxt 4 desktop admin portal for KF Maction v2.0.

Server-rendered (SSR) administration and reporting interface for Super Admin,
Admin Pusat, and Admin Cabang roles. Unlike `field-pwa`, this app is **not** a PWA.

## Stack

- Nuxt 4 (Vue 3 Composition API, `<script setup lang="ts">`)
- Nuxt UI (Tailwind CSS + Reka)
- Pinia (state management)
- Leaflet + `@vue-leaflet/vue-leaflet` + `leaflet.markercluster` (admin maps)
- Shared workspace packages: `@maction/types`, `@maction/utils`

## Scripts

```bash
pnpm --filter web-portal dev        # start dev server
pnpm --filter web-portal build      # production build
pnpm --filter web-portal typecheck  # type check
pnpm --filter web-portal lint       # lint
pnpm --filter web-portal test       # run unit tests
```
