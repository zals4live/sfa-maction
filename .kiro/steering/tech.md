# Technology Stack & Runtime Rules

This steering file defines the technology stack, runtime constraints, and framework-specific rules for KF Maction v2.0.

---

## Runtime & Language

- **Language**: TypeScript (strict mode) across all layers — frontend, backend, and shared packages
- **Backend Runtime**: **Bun v1.4** — used as both package manager and runtime
- **Frontend Runtime**: Node.js / Bun for Nuxt SSR build and dev server

---

## Backend (services/api-server)

| Concern | Technology | Rules |
|---------|-----------|-------|
| HTTP Framework | **Elysia.js** on Bun v1.4 | Use Elysia plugins for JWT, CORS, rate-limit. Validation via TypeBox schemas. |
| Database | **PostgreSQL 16+ with PostGIS** (AWS RDS) | Always use parameterized queries. Spatial queries use `ST_DWithin`, `ST_DistanceSphere`. |
| ORM / Query Builder | **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) | Type-safe query building, migration generation, native PostGIS SQL integration, session RLS setters via Drizzle transactions. Raw SQL only for PostGIS functions or materialized view refresh. |
| Caching & Queue | **Redis** (AWS ElastiCache) | Use for: session store, rate-limiting, dashboard cache (TTL 5-15 min), BullMQ job queue. |
| Job Queue | **BullMQ** on Redis | All ERP sync jobs use idempotency keys. Retry with exponential backoff. |
| Object Storage | **AWS S3** | Pre-signed URLs for uploads (photos, signatures). Never expose S3 keys to client. |
| Multi-Tenancy | PostgreSQL RLS + Elysia middleware | Every request sets `SET LOCAL app.current_company_id`, `app.current_user_id`, `app.current_user_role`. Never bypass RLS. |

### Backend Rules

- Every Elysia route handler must go through the tenant-guard middleware that sets `app.current_company_id`, `app.current_user_id`, and `app.current_user_role`
- JWT tokens contain: `user_id`, `company_id`, `soffice_id`, `role_label` (`SALESMAN` | `MR` | `ADMIN_CABANG` | `ADMIN_PUSAT` | `SUPER_ADMIN`), and `lini_ids` (array of assigned business line UUIDs)
- Use TypeBox for request/response validation schemas — colocate schemas with route modules
- Group routes by module: `src/modules/{module-name}/routes.ts`
- Database transactions: wrap multi-table mutations in explicit Drizzle transactions with RLS context setters
- Never return raw PostgreSQL errors to the client — map to structured API error responses
- ERP integration payloads always include an `idempotency_key` field
- RBAC middleware must gate order-taking endpoints (`POST /orders`, `POST /orders/:id/submit`) to `SALESMAN` role only — `MR` receives `403 Forbidden`
- Drizzle schema definitions live in `src/db/schema/` with relations in `src/db/relations.ts`
- Migration generation via `drizzle-kit` configured in `drizzle.config.ts`

---

## Frontend (apps/field-pwa & apps/web-portal)

| Concern | Technology | Rules |
|---------|-----------|-------|
| Framework | **Nuxt 4** (Vue 3 Composition API) | Use `<script setup lang="ts">` exclusively. No Options API. |
| UI Library | **Nuxt UI** (Tailwind CSS + Radix/Reka) | Prefer Nuxt UI components over custom implementations. |
| Styling | **Tailwind CSS** | Use design tokens from Nuxt UI theme. No inline styles. No raw CSS unless unavoidable. |
| Color Mode | **Forced Light Mode** | `preference: 'light'`, `fallback: 'light'`. Dark mode explicitly disabled for outdoor readability. |
| Maps | **Leaflet** + `@vue-leaflet/vue-leaflet` + `leaflet.markercluster` | Client-side geodesic math with **Turf.js**. |
| PWA | **@vite-pwa/nuxt** | Workbox precaching for static assets. Background Sync API for offline queue. |
| Offline Storage | **Dexie.js** (IndexedDB) | Compound primary key `[company_id+id]`. Schema defined in `apps/field-pwa/database/`. |
| State Management | **Pinia** | Use for auth state, cart state, attendance state. Offline-persistent where needed. |
| API Client | Nuxt `$fetch` / `useFetch` | Centralize in composables (e.g., `useApiClient`). Handle offline fallback gracefully. |

### Frontend Rules

- All pages use `definePageMeta` for middleware and layout assignment
- Composables are the primary abstraction for reusable logic — prefix with `use`
- Components follow atomic design: base components in `components/`, page-specific in `components/{feature}/`
- Leaflet map instances must be lazy-loaded (`ClientOnly` or dynamic import) to avoid SSR issues
- Dexie.js tables mirror backend master data schemas for offline access, including `user_lini_assignments` and `materials` (lini-filtered)
- Outbox mutations use the `LocalOutboxMutation` interface with `sync_status` tracking and `user_role` field for role-adaptive sync
- PWA must display real-time connectivity status (Online / Offline / Syncing) in the top navbar
- Photos are uploaded via S3 pre-signed URLs — never send binary data through the API server
- **Forced Light Mode**: Both apps configure `colorMode: { preference: 'light', fallback: 'light' }` in `nuxt.config.ts`. No dark mode classes or toggles.
- **Role-adaptive UI**: Field PWA uses `useRoleGuard` composable to conditionally render in-visit steps — `SALESMAN` sees Taking Order, `MR` sees Price/Stock Lookup (read-only)
- Material catalog views are filtered by the user's `lini_ids` from JWT claims

---

## Shared Packages (packages/)

| Package | Purpose |
|---------|---------|
| `packages/types` | Shared TypeScript interfaces and enums (Customer, Doctor, Visit, Order, Report, Lini, Varian) |
| `packages/utils` | Shared utility functions: Turf.js spatial helpers, report exporters, UOM converters, formatters |

### Rules

- Shared types must be framework-agnostic — no Vue or Elysia imports
- Enum values must match PostgreSQL enum definitions exactly (including `MR` in `user_label_enum`)
- Export everything from `index.ts` barrel file

---

## Infrastructure & Deployment

| Concern | Technology |
|---------|-----------|
| Local Dev | **OrbStack Docker Compose** — PostgreSQL 16 + PostGIS, Redis |
| Production | **AWS EC2** (Ubuntu) with Nginx reverse proxy |
| Database (Prod) | **AWS RDS PostgreSQL 16+** with PostGIS extension |
| Cache (Prod) | **AWS ElastiCache Redis** |
| Storage (Prod) | **AWS S3** with lifecycle rules |
| CI/CD | **GitHub Actions** — lint, typecheck, build, SSH deploy to EC2 |
| Process Management | **systemd** services on EC2 (maction-api.service, maction-portal.service) |

### Infrastructure Rules

- Nginx handles SSL termination, HTTP/2, compression, and WebSocket upstreaming
- Never expose Elysia or Nuxt ports directly — always behind Nginx
- Database migrations are generated by `drizzle-kit` and stored as versioned SQL files in `services/api-server/migrations/`
- Environment variables for secrets — never commit `.env` files
- S3 bucket CORS configured for pre-signed upload from PWA origins only

---

## Package Manager

- Use **pnpm** as the workspace package manager (defined in `pnpm-workspace.yaml`)
- Workspace packages referenced via `workspace:*` protocol
- Lock file (`pnpm-lock.yaml`) must always be committed
