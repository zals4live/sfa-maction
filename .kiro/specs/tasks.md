# Tasks — KF Maction v2.0

Sequential implementation task breakdown for all modules. Tasks are ordered by dependency — foundational infrastructure first, then features layered on top.

Reference: #[[file:docs/PRD_Maction_v2.md]]

---

## Phase 0: Infrastructure & Project Scaffold

- [x] Initialize pnpm monorepo with `pnpm-workspace.yaml` defining `apps/*`, `services/*`, `packages/*`
- [x] Create root `package.json` with workspace scripts (dev, build, lint, typecheck, test)
- [x] Create `packages/types/` with barrel `index.ts` and shared enum/interface definitions matching PostgreSQL enums (including `MR` in UserRole)
- [x] Create `packages/utils/` with barrel `index.ts` (placeholder for spatial helpers, UOM converters, formatters)
- [x] Set up `infra/docker/docker-compose.yml` with PostgreSQL 16 + PostGIS and Redis containers
- [x] Create `infra/postgres/init-scripts/01_extensions.sql` (PostGIS, uuid-ossp, enum types including `MR` in `user_label_enum`)
- [x] Create `infra/postgres/init-scripts/02_schema_ddl.sql` (all tables from PRD Section 6 including `master_lini`, `master_varian`, `user_lini_assignments`)
- [x] Create `infra/postgres/init-scripts/03_reporting_views.sql` (materialized views with Salesman vs MR segmentation & indexes)
- [x] Create `infra/postgres/init-scripts/04_audit_tables.sql` (audit & fraud telemetry schemas)
- [x] Create `infra/postgres/init-scripts/05_rls_policies.sql` (RLS policies for all tenant-scoped tables, lini-scoped material policy, orders role restriction)
- [x] Set up `infra/nginx/` with reverse proxy config template (SSL, compression, WebSocket upstream)
- [x] Set up `infra/systemd/` service unit files for Elysia API and Nuxt SSR
- [x] Create `infra/aws-s3/bucket-cors-policy.json` with CORS rules for PWA origins
- [x] Create `.github/workflows/ci-test.yml` (lint, typecheck, unit test on PR)
- [x] Create `.github/workflows/ai-pr-reviewer.yml` (automated AI code reviewer)
- [x] Create `.github/workflows/deploy-ec2.yml` (build + SSH deploy pipeline)

---

## Phase 1: Backend API Server Foundation

- [x] Initialize `services/api-server/` with Bun + Elysia.js + Drizzle ORM project scaffold
- [x] Configure `drizzle.config.ts` — Drizzle Kit configuration (schema path, migrations output)
- [x] Configure `src/config/database.ts` — PostgreSQL connection pool with SSL for RDS (Drizzle ORM)
- [x] Configure `src/config/redis.ts` — Redis/ElastiCache connection
- [x] Configure `src/config/s3.ts` — AWS S3 client with pre-signed URL generation utility
- [x] Implement `src/db/schema/` — Drizzle TypeScript schema definitions for all tables (auth, tenant, customer, material, visit, order, audit)
- [x] Implement `src/db/relations.ts` — Drizzle relational mappings for all table relationships
- [x] Implement `src/db/index.ts` — Drizzle DB instance with RLS transaction helper
- [x] Implement `src/db/rls.ts` — utility to set `app.current_company_id`, `app.current_user_id`, `app.current_user_role` within transactions
- [x] Implement `src/middleware/tenantGuard.ts` — extract JWT claims, set all three RLS session variables
- [x] Implement `src/middleware/roleGuard.ts` — RBAC role-based route access enforcement (Salesman-only, Admin-only gates)
- [x] Implement `src/middleware/rateLimiter.ts` — Redis-backed rate limiting plugin
- [x] Create `.env.example` with all required environment variable placeholders
- [x] Implement health check endpoint `GET /health` returning service status

---

## Phase 2: Module 1 — Multi-Tenant Management

- [x] Implement `src/modules/tenant/schemas.ts` — TypeBox schemas for Company CRUD
- [x] Implement `src/modules/tenant/service.ts` — create, list, update, deactivate companies
- [x] Implement `src/modules/tenant/routes.ts` — `GET/POST/PATCH /tenants`, deactivate endpoint
- [x] Implement ERP config endpoint `PUT /tenants/:id/erp-config`
- [x] Implement tenant kill-switch logic — invalidate Redis sessions on deactivation
- [x] Add tenant branding fields (logo, tax rate, geofence radius) to create/update flows

---

## Phase 3: Module 2 — Authentication & Security

- [x] Implement `src/modules/auth/schemas.ts` — login request/response schemas
- [x] Implement `src/modules/auth/service.ts` — password verification, JWT generation (including `lini_ids` in payload), session management
- [x] Implement `src/modules/auth/routes.ts` — `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- [x] Implement single-session enforcement — Redis session tracking, invalidation on new login
- [x] Implement `src/middleware/antiSpoof.ts` — velocity check hook using PostGIS `ST_DistanceSphere`
- [x] Implement graduated fraud response — soft rejection + telemetry logging to `audit_fraud_telemetry`
- [x] Add role-based route guards (Super Admin, Admin Pusat, Admin Cabang, Salesman, MR)
- [x] Implement MR order restriction — `403 Forbidden` on order-taking endpoints for `MR` role

---

## Phase 4: Module 3 — GPS Attendance

- [x] Implement `src/modules/attendance/schemas.ts` — check-in/out validation schemas with geom + accuracy
- [x] Implement `src/modules/attendance/service.ts` — check-in with geofence validation, check-out with time rule
- [x] Implement `src/modules/attendance/routes.ts` — `POST /attendance/check-in`, `POST /attendance/check-out`, `GET /attendance/today`, `GET /attendance/history`
- [x] Implement PostGIS distance calculation between submitted coords and `master_soffice.location_geom`
- [x] Implement attendance locking logic — block visit features when no valid check-in exists today (applies to both Salesman & MR)
- [x] Implement conditional checkout rule — enable only after 16:00 or shift end
- [x] Implement S3 pre-signed URL flow for selfie upload with photo key persistence

---

## Phase 5: Module 4 — Master Hierarchy, Lini & Customer/Doctor Management

- [x] Implement `src/modules/lini/schemas.ts` — TypeBox schemas for Lini and Varian CRUD
- [x] Implement `src/modules/lini/service.ts` — CRUD for `master_lini` and `master_varian` with soft-delete
- [x] Implement `src/modules/lini/routes.ts` — `GET/POST/PATCH/DELETE /lini`, `GET/POST/PATCH/DELETE /varian`
- [x] Implement user-lini assignment endpoints — `GET/POST/DELETE /users/:id/lini`
- [x] Implement `src/modules/customer/schemas.ts` — CRUD schemas for Outlet and Doctor types
- [x] Implement `src/modules/customer/service.ts` — full CRUD with soft-delete, spatial pinpoint, PIC management
- [x] Implement `src/modules/customer/routes.ts` — all `/customers` endpoints including bulk import
- [x] Implement `src/modules/doctor/schemas.ts` — doctor profile and assignment schemas
- [x] Implement `src/modules/doctor/service.ts` — profile management, multi-outlet assignment CRUD
- [x] Implement `src/modules/doctor/routes.ts` — `/doctors` endpoints with assignments sub-resource
- [x] Implement geofence inheritance logic — resolve outlet coordinates for doctor visits
- [x] Implement bulk import endpoint with XLSX/CSV parsing and validation streaming

---

## Phase 6: Module 5 — Sales Call Plan (SCP/MVP)

- [x] Implement `src/modules/call-plan/schemas.ts` — plan upload and query schemas
- [x] Implement `src/modules/call-plan/service.ts` — bulk create plans (for both Salesman & MR), today's plan query, analytics computation
- [x] Implement `src/modules/call-plan/routes.ts` — `GET/POST /call-plans`, `/call-plans/today`, `/call-plans/analytics`
- [x] Implement call rate calculation: `(actual_visits / target_plans) × 100` segmented by role
- [x] Implement visit type auto-classification (PLANNED vs EXTRA) based on matching plan records

---

## Phase 7: Module 6 — Field Visit Execution

- [x] Implement `src/modules/visit/schemas.ts` — visit start/end, agenda, audit schemas
- [x] Implement `src/modules/visit/service.ts` — visit-in with geofence check (Salesman & MR), concurrent lock, visit-out
- [x] Implement `src/modules/visit/routes.ts` — `POST /visits/start`, `POST /visits/:id/end`, sub-resource endpoints
- [x] Implement geofence validation at visit-in using PostGIS `ST_DWithin` against target outlet
- [x] Implement concurrent visit lock — prevent new visit if prior is still open
- [x] Implement agenda/detailing CRUD (`visit_agendas` table) — accessible by both Salesman & MR
- [x] Implement stock audit CRUD (`visit_stock_audits` table) — accessible by both Salesman & MR
- [x] Implement competitor audit CRUD (`visit_competitor_audits` table) — accessible by both Salesman & MR
- [x] Implement digital signature capture — S3 key storage on visit completion

---

## Phase 8: Module 7 — SFA & Order Taking (Salesman Exclusive)

- [x] Implement `src/modules/order/schemas.ts` — create order, submit order schemas
- [x] Implement `src/modules/order/service.ts` — order creation with price lookup, UOM conversion, tax calc
- [x] Implement `src/modules/order/routes.ts` — `POST/GET /orders`, `POST /orders/:id/submit`, PDF endpoint
- [x] Implement role guard on all order write routes — `SALESMAN` only, `MR` gets `403`
- [x] Implement `src/modules/material/schemas.ts` — material query schemas with lini filter
- [x] Implement `src/modules/material/service.ts` — material list (lini-filtered by RLS), price lookup, stock ATP lookup
- [x] Implement `src/modules/material/routes.ts` — `GET /materials`, `GET /materials/:id/price`, `GET /materials/:id/stock`, `GET /promotions`
- [x] Implement multi-tier UOM conversion using `master_material.uom_conversion_rules` JSON
- [x] Implement regional price lookup from `master_price` by soffice + material + varian + valid date range
- [x] Implement promotion/discount application logic from `master_promotions`
- [x] Implement automated PPN tax calculation with tenant `default_tax_rate`
- [x] Implement order number generation (sequential per tenant)
- [x] Implement PDF quotation generation with tenant branding → upload to S3

---

## Phase 9: Module 9 — ERP Integration

- [x] Implement `src/modules/erp-sync/schemas.ts` — webhook payload schemas for all inbound types
- [x] Implement `src/modules/erp-sync/routes.ts` — webhook endpoints for customers, materials, prices, stock (with batch/SLED), promos, leads
- [x] Implement inbound customer/doctor delta sync (upsert matching `erp_customer_code`)
- [x] Implement inbound material/SKU sync (upsert matching `erp_material_code`, including `lini_id`)
- [x] Implement inbound price list sync (upsert `master_price` records with `varian_id` and `per`)
- [x] Implement inbound stock ATP sync (upsert `stock_inventory_atp` with batch & SLED)
- [x] Implement inbound promotion sync (upsert `master_promotions` with UOM references)
- [x] Implement inbound leads → auto-create `visit_plans` for relevant salesmen or MRs
- [x] Implement `src/queues/erpSyncWorker.ts` — BullMQ worker for outbound order → ERP Sales Quotation
- [x] Implement idempotency key generation and Redis duplicate detection
- [x] Implement exponential backoff retry logic on ERP sync failure
- [x] Implement `audit_erp_sync_logs` recording for every sync operation

---

## Phase 10: Module 11 — Audit & Fraud Telemetry

- [ ] Implement Elysia.js audit interceptor — auto-log mutations to `audit_mutation_logs`
- [ ] Implement fraud telemetry service — structured writes to `audit_fraud_telemetry`
- [ ] Implement ERP sync audit logging within the sync worker
- [ ] Implement visit lifecycle audit stream (timestamp progression tracking for Salesman & MR)

---

## Phase 11: Module 12 — Reporting & Dashboard API

- [ ] Implement `src/modules/report/routes.ts` — all `/reports/*` endpoints
- [ ] Implement dashboard KPI aggregation from `mv_daily_branch_performance` materialized view (Salesman vs MR segmented)
- [ ] Implement `src/queues/mvRefreshWorker.ts` — periodic materialized view refresh via BullMQ
- [ ] Implement Redis caching layer for dashboard responses (TTL 5-15 min)
- [ ] Implement branch performance matrix query (ranking by visits, revenue, strike rate — Salesman vs MR)
- [ ] Implement call rate report with user/branch/tenant level aggregation and role filter
- [ ] Implement fraud incident report query from `audit_fraud_telemetry`
- [ ] Implement order/quotation transaction register with multi-variable filtering
- [ ] Implement streaming Excel export endpoint (`.xlsx` generation without blocking event loop)
- [ ] Implement streaming PDF executive summary export endpoint

---

## Phase 12: Frontend — Nuxt 4 Field PWA (apps/field-pwa)

- [ ] Initialize Nuxt 4 project with `@vite-pwa/nuxt`, Nuxt UI, Tailwind CSS, Pinia
- [ ] Configure `nuxt.config.ts` with Forced Light Mode (`colorMode: { preference: 'light', fallback: 'light' }`), PWA manifest, Workbox precaching, Leaflet CSS
- [ ] Implement `database/index.ts` — Dexie.js schema with all offline tables (customers, doctor_profiles, doctor_outlet_assignments, user_lini_assignments, materials, visit_plans, outbox_mutations) and compound indexes
- [ ] Implement `composables/useOfflineDb.ts` — CRUD wrappers for Dexie.js tables
- [ ] Implement `composables/useBackgroundSync.ts` — outbox queue management and Service Worker sync (with `user_role` in mutations)
- [ ] Implement `composables/useGeofence.ts` — distance calculation, radar state, proximity validation
- [ ] Implement `composables/useAntiSpoof.ts` — mock location detection, monotonic clock anchoring
- [ ] Implement `composables/useApiClient.ts` — centralized fetch with offline fallback
- [ ] Implement `composables/useRoleGuard.ts` — role-adaptive UI logic (conditionally render Salesman vs MR in-visit steps, hide order tab for MR)
- [ ] Implement `stores/useAuthStore.ts` — JWT management (including `lini_ids`), login/logout, user profile
- [ ] Implement `stores/useAttendanceStore.ts` — today's attendance state, lock/unlock logic
- [ ] Implement `stores/useCartStore.ts` — order cart state with offline persistence (Salesman only, guarded by role)
- [ ] Implement auth layout and login page (`/auth/login`)
- [ ] Implement main app layout with bottom navigation (conditionally hide "Order" tab for MR) and connectivity status bar
- [ ] Implement check-in page (`/app/checkin`) — category selection, selfie camera, geofence display (Salesman & MR)
- [ ] Implement visit list page (`/app/visits`) — today's MVP with status indicators (Salesman & MR)
- [ ] Implement visit-in page with Leaflet geofence radar (`components/map/GeofenceRadar.vue`)
- [ ] Implement in-visit execution hub (`/app/visits/[id]/in-visit`) — role-adaptive tabbed steps:
  - Salesman: [Detailing] → [Competitor] → [Stock] → [Taking Order]
  - MR: [Detailing] → [Product Info & Stock (read-only)] → [Competitor]
- [ ] Implement detailing/agenda form (`components/in-visit/AgendaForm.vue`) — shared by Salesman & MR
- [ ] Implement competitor audit form (`components/in-visit/CompetitorForm.vue`) — shared by Salesman & MR
- [ ] Implement stock audit form (`components/in-visit/StockAuditForm.vue`) — shared by Salesman & MR
- [ ] Implement order cart / taking order form (`components/in-visit/OrderCart.vue`) — Salesman only, hidden for MR
- [ ] Implement price & stock lookup (read-only) component (`components/in-visit/PriceStockLookup.vue`) — MR only
- [ ] Implement digital signature canvas (`components/signature/SignaturePad.vue`)
- [ ] Implement visit-out flow — signature capture + GPS + monotonic timestamp
- [ ] Implement by-phone order entry page (`/app/orders`) — Salesman only, page guarded by `useRoleGuard`
- [ ] Implement profile/settings page (`/app/profile`)
- [ ] Implement master data sync on app launch (customers, doctors, assignments, user-lini assignments, materials filtered by lini, visit plans)
- [ ] Implement visual sync status indicator component (Online/Offline/Syncing/Error states)
- [ ] Implement daily route polyline map view (`components/map/RoutePolyline.vue`)

---

## Phase 13: Frontend — Nuxt 4 Web Portal (apps/web-portal)

- [ ] Initialize Nuxt 4 project with Nuxt UI, Tailwind CSS, Pinia, Leaflet
- [ ] Configure `nuxt.config.ts` with Forced Light Mode, SSR settings, API proxy, auth middleware
- [ ] Implement admin dashboard layout with collapsible sidebar navigation
- [ ] Implement auth layout and login page
- [ ] Implement `composables/useApiClient.ts` — server-side fetch with tenant context
- [ ] Implement `composables/useTenant.ts` — tenant selection and context management
- [ ] Implement `composables/useReporting.ts` — report data fetching and caching
- [ ] Implement executive KPI dashboard page (`/admin/dashboard`) — metric cards + charts (Salesman vs MR segmented)
- [ ] Implement live tracking page (`/admin/tracking`) — Leaflet map with real-time Salesman & MR positions
- [ ] Implement customer management pages (`/admin/customers`) — CRUD table with search/filter (Outlet & Doctor types)
- [ ] Implement customer 360 view with doctor affiliations, PIC contacts, map pinpoint
- [ ] Implement doctor management with assignment matrix
- [ ] Implement lini & varian management pages — CRUD with user assignment interface
- [ ] Implement call plan management page (`/admin/call-plans`) — upload for Salesman & MR, approval, analytics
- [ ] Implement order approval/review pages (`/admin/orders`) — Salesman orders only
- [ ] Implement reporting center (`/admin/reports`) — tabbed reports with date/branch/role filters
- [ ] Implement Excel/PDF export buttons using streaming download
- [ ] Implement fraud & audit telemetry viewer (`/admin/audit`)
- [ ] Implement tenant administration pages (Super Admin only: `/admin/super/tenants`)
- [ ] Implement ERP configuration page (Super Admin: `/admin/super/erp-config`)
- [ ] Implement GPS recalibration map tool (`components/map/PinPicker.vue`)
- [ ] Implement territory clustering map (`components/map/TerritoryCluster.vue`)
- [ ] Implement branch performance league table component (Salesman & MR ranking)
- [ ] Implement attendance & fraud incident report page

---

## Phase 14: Module 10 — Maps & Spatial Visualization (Cross-App)

- [ ] Implement `GeofenceRadar.vue` — Leaflet circle + pulsing marker + distance label (field-pwa, used by Salesman & MR)
- [ ] Implement `RoutePolyline.vue` — Turf.js geodesic route with MVP waypoints (field-pwa)
- [ ] Implement `LiveTrackingMap.vue` — real-time Salesman & MR markers + breadcrumb trails (web-portal)
- [ ] Implement `TerritoryCluster.vue` — markercluster outlet/doctor coverage density (web-portal)
- [ ] Implement `PinPicker.vue` — interactive coordinate picker modal (web-portal)
- [ ] Implement GPS deep link integration for navigation to next visit target (field-pwa)

---

## Phase 15: PWA Offline & Background Sync Polish

- [ ] Verify full offline workflow: check-in → visit-in → all in-visit activities → visit-out → order (Salesman) / no-order (MR)
- [ ] Verify role-adaptive outbox: `ORDER_SUBMIT` mutations only created by `SALESMAN`, never by `MR`
- [ ] Verify Background Sync API triggers correctly on connectivity restore
- [ ] Verify FIFO ordering of outbox mutations during batch sync
- [ ] Verify conflict resolution — server timestamp wins, client re-fetches
- [ ] Verify connectivity indicator transitions (Online ↔ Offline ↔ Syncing ↔ Error)
- [ ] Verify Workbox precaching covers all critical app shell assets
- [ ] Verify lini-filtered material sync — only user's assigned lini materials cached locally
- [ ] Test PWA installation on Android and iOS (Add to Home Screen)

---

## Phase 16: Integration Testing & End-to-End Validation

- [ ] End-to-end test: full Salesman daily workflow (check-in → visits → orders → check-out → ERP sync)
- [ ] End-to-end test: full MR daily workflow (check-in → visits → detailing → price/stock lookup → no orders → check-out)
- [ ] Test MR order restriction — verify `403 Forbidden` on all order creation attempts (API + PWA UI)
- [ ] Test multi-lini scoping — verify field users only see materials from assigned lini
- [ ] Test multi-tenant isolation — verify zero cross-tenant data leakage via RLS
- [ ] Test anti-spoofing pipeline — mock location, velocity anomaly, clock drift scenarios
- [ ] Test ERP sync retry logic — simulate ERP downtime, verify BullMQ retries with backoff
- [ ] Test concurrent session invalidation — login from two devices
- [ ] Test geofence boundary conditions — exactly at radius, slightly outside
- [ ] Test offline → online sync with network interruption during sync
- [ ] Test bulk import with valid and invalid rows — verify partial success reporting
- [ ] Performance test: API response times under load (target ≤ 100ms p95)
- [ ] Performance test: materialized view dashboard queries (target ≤ 150ms)

---

## Phase 17: Production Deployment & CI/CD

- [ ] Configure AWS RDS PostgreSQL 16 with PostGIS extension enabled
- [ ] Configure AWS ElastiCache Redis cluster
- [ ] Configure AWS S3 bucket with CORS policy and lifecycle rules
- [ ] Set up EC2 instance with Ubuntu, Nginx, Bun runtime
- [ ] Deploy Nginx configuration with SSL certificates (Let's Encrypt or ACM)
- [ ] Deploy systemd service units for Elysia API and Nuxt SSR
- [ ] Configure GitHub Actions secrets for SSH deployment
- [ ] Validate CI pipeline: lint → typecheck → build → deploy
- [ ] Run Drizzle migrations on production RDS
- [ ] Smoke test all critical endpoints in production (including MR role restriction)
- [ ] Verify PWA installation and offline behavior in production
- [ ] Verify Forced Light Mode renders correctly across devices
