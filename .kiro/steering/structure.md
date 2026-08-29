# Monorepo Structure & File Naming Conventions

This steering file maps the directory structure and establishes naming rules for all files and modules in the KF Maction v2.0 monorepo.

---

## Root Monorepo Layout

```
maction-v2/
├── .github/workflows/          # CI/CD pipelines
│   ├── ci-test.yml             # PR Quality Gate (Lint, Typecheck, Unit Test)
│   ├── ai-pr-reviewer.yml     # Automated AI Code Reviewer Bot
│   └── deploy-ec2.yml         # Production Deployment (Build & SSH Deploy to AWS EC2)
├── .kiro/                      # AI steering & specs
│   ├── settings/
│   │   └── mcp.json           # MCP server configuration
│   ├── steering/               # Permanent architectural rules (this file)
│   └── specs/                  # Feature specifications (requirements, design, tasks)
├── apps/                       # Client applications
│   ├── web-portal/             # Nuxt 4 desktop admin portal
│   └── field-pwa/              # Nuxt 4 mobile PWA for field force (Salesman & MR)
├── services/                   # Backend services
│   └── api-server/             # Elysia.js + Drizzle ORM backend on Bun
├── packages/                   # Shared internal libraries
│   ├── types/                  # Shared TypeScript definitions
│   └── utils/                  # Shared utility functions
├── infra/                      # Infrastructure & deployment
│   ├── docker/                 # Local dev containers (docker-compose.yml)
│   ├── nginx/                  # Production Nginx configs
│   ├── systemd/                # Systemd service units
│   ├── postgres/               # PostgreSQL init scripts & migrations
│   └── aws-s3/                 # S3 CORS & lifecycle configs
├── docs/                       # Architecture documentation & PRD
├── package.json                # Root monorepo scripts
└── pnpm-workspace.yaml         # Workspace definitions
```

---

## App: web-portal (apps/web-portal/)

```
apps/web-portal/
├── components/                 # Reusable Vue components
│   ├── dashboard/              # KPI cards, charts (Salesman vs MR segmented)
│   ├── map/                    # Leaflet admin tracking map (Salesman & MR positions)
│   ├── customer/               # Customer/Doctor 360 views
│   └── report/                 # Report tables, export buttons
├── composables/                # Shared logic hooks
│   ├── useApiClient.ts
│   ├── useTenant.ts
│   ├── useReporting.ts
│   └── useERPConfig.ts
├── layouts/                    # Page layouts
│   ├── default.vue             # Admin dashboard layout with sidebar
│   └── auth.vue                # Login/auth pages layout
├── pages/                      # File-based routing
│   ├── admin/
│   │   ├── dashboard.vue
│   │   ├── reports/
│   │   ├── tracking.vue
│   │   ├── customers/
│   │   ├── call-plans/
│   │   └── settings/
│   └── auth/
│       └── login.vue
├── stores/                     # Pinia state stores
├── nuxt.config.ts              # Forced Light Mode, Nuxt UI
└── package.json
```

---

## App: field-pwa (apps/field-pwa/)

```
apps/field-pwa/
├── components/
│   ├── map/                    # Leaflet geofence radar, route polyline
│   ├── in-visit/               # Agenda, display audit, stock audit, cart form (Salesman), price/stock lookup (MR)
│   └── signature/              # HTML5 signature canvas
├── composables/
│   ├── useOfflineDb.ts         # Dexie.js CRUD wrappers
│   ├── useGeofence.ts          # Distance calc & radar logic
│   ├── useBackgroundSync.ts    # Service Worker sync queue
│   ├── useAntiSpoof.ts         # Mock detection & clock validation
│   └── useRoleGuard.ts         # Role-adaptive UI logic (Salesman vs MR step gating)
├── database/                   # Dexie.js schema definitions
│   └── index.ts                # MactionDexieDb class & table schemas
├── pages/
│   ├── app/
│   │   ├── checkin.vue         # Daily attendance (Salesman & MR)
│   │   ├── visits/
│   │   │   ├── index.vue       # Visit list (today's MVP)
│   │   │   └── [id]/
│   │   │       └── in-visit.vue # In-visit execution hub (role-adaptive steps)
│   │   ├── orders/
│   │   │   └── index.vue       # Order history & by-phone entry (Salesman only)
│   │   └── profile.vue
│   └── auth/
│       └── login.vue
├── stores/
│   ├── useAuthStore.ts
│   ├── useCartStore.ts         # Salesman-only cart state
│   └── useAttendanceStore.ts
├── public/                     # PWA icons & web manifest
├── nuxt.config.ts              # Forced Light Mode, @vite-pwa/nuxt, Workbox Caching
└── package.json
```

---

## Service: api-server (services/api-server/)

```
services/api-server/
├── src/
│   ├── config/                 # Connection configs
│   │   ├── database.ts         # PostgreSQL pool setup (Drizzle ORM)
│   │   ├── redis.ts            # Redis/ElastiCache connection
│   │   └── s3.ts               # AWS S3 client
│   ├── db/                     # Drizzle ORM schema definitions & helpers
│   │   ├── schema/             # Drizzle TypeScript schema definitions
│   │   │   ├── auth.ts         # app_users, user_lini_assignments
│   │   │   ├── tenant.ts       # companies, master_soffice, master_lini, master_varian
│   │   │   ├── customer.ts     # master_customer, doctor_profiles, doctor_outlet_assignments, master_pic
│   │   │   ├── material.ts     # master_material, master_price, stock_inventory_atp, master_promotions
│   │   │   ├── visit.ts        # visit_plans, visits, visit_agendas, visit_stock_audits, visit_competitor_audits
│   │   │   ├── order.ts        # orders, order_items
│   │   │   ├── audit.ts        # audit_mutation_logs, audit_fraud_telemetry, audit_erp_sync_logs
│   │   │   └── index.ts        # Barrel export of all schemas + enums
│   │   ├── relations.ts        # Drizzle relational mappings
│   │   ├── rls.ts              # RLS setter utility (company_id, user_id, user_role)
│   │   └── index.ts            # Drizzle DB instance & RLS transaction helper
│   ├── modules/                # Feature modules (routes + services)
│   │   ├── auth/
│   │   ├── attendance/
│   │   ├── customer/
│   │   ├── doctor/
│   │   ├── visit/
│   │   ├── order/
│   │   ├── call-plan/
│   │   ├── material/
│   │   ├── lini/               # Business line & varian CRUD
│   │   ├── report/
│   │   ├── tenant/
│   │   └── erp-sync/
│   ├── middleware/             # Cross-cutting Elysia plugins
│   │   ├── tenantGuard.ts      # Sets app.current_company_id, user_id, user_role
│   │   ├── roleGuard.ts        # RBAC role-based route access enforcement
│   │   ├── antiSpoof.ts        # Velocity & mock checks
│   │   └── rateLimiter.ts      # Redis-backed rate limiting
│   ├── queues/                 # BullMQ workers
│   │   ├── erpSyncWorker.ts
│   │   └── mvRefreshWorker.ts
│   └── index.ts                # Elysia server entrypoint
├── drizzle.config.ts           # Drizzle Kit configuration (migrations, schema path)
├── migrations/                 # Drizzle-generated versioned SQL migration files
├── .env.example
└── package.json
```

---

## Module Structure Convention (api-server)

Each module in `services/api-server/src/modules/{name}/` follows:

```
modules/{name}/
├── routes.ts                   # Elysia route definitions
├── service.ts                  # Business logic functions
├── schemas.ts                  # TypeBox validation schemas
└── types.ts                    # Module-specific types (if not in packages/types)
```

---

## File Naming Rules

| Context | Convention | Example |
|---------|-----------|---------|
| Vue components | PascalCase `.vue` | `GeofenceRadar.vue`, `OrderCart.vue` |
| Composables | camelCase prefixed with `use` | `useGeofence.ts`, `useRoleGuard.ts` |
| Pinia stores | camelCase prefixed with `use...Store` | `useAuthStore.ts`, `useCartStore.ts` |
| Pages (Nuxt) | kebab-case `.vue` | `call-plans.vue`, `in-visit.vue` |
| Backend modules | kebab-case directory | `erp-sync/`, `call-plan/`, `lini/` |
| Backend files | camelCase `.ts` | `tenantGuard.ts`, `roleGuard.ts`, `erpSyncWorker.ts` |
| Drizzle schema files | camelCase `.ts` | `auth.ts`, `customer.ts`, `material.ts` |
| SQL migrations | Drizzle-generated numbered files | `0001_create_companies.sql` |
| PostgreSQL tables | snake_case | `master_customer`, `doctor_outlet_assignments`, `user_lini_assignments` |
| PostgreSQL enums | snake_case with `_enum` suffix | `user_label_enum`, `order_status_enum` |
| TypeScript interfaces | PascalCase | `MasterCustomer`, `LocalOutboxMutation` |
| TypeScript enums | PascalCase | `CustomerType`, `OrderStatus`, `UserRole` |
| Environment variables | SCREAMING_SNAKE_CASE | `DATABASE_URL`, `AWS_S3_BUCKET` |
| S3 keys | Path-style with tenant prefix | `{company_id}/photos/{year}/{uuid}.jpg` |

---

## Import Path Aliases

| Alias | Resolves To |
|-------|------------|
| `@/` | App-relative src root (Nuxt auto-resolves) |
| `@maction/types` | `packages/types` workspace package |
| `@maction/utils` | `packages/utils` workspace package |

---

## Workspace Package References

In `pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'services/*'
  - 'packages/*'
```

In any app/service `package.json`, reference shared packages:
```json
{
  "dependencies": {
    "@maction/types": "workspace:*",
    "@maction/utils": "workspace:*"
  }
}
```
