# Design — KF Maction v2.0

This document defines the API contracts, state models, database schemas, and client-side data architecture for all modules.

Reference: #[[file:docs/PRD_Maction_v2.md]]

---

## 1. API Contract Overview

Base URL: `https://api.maction.kimiafarma.co.id`

All endpoints require `Authorization: Bearer <JWT>` except `/auth/login`.

### Common Headers

```
Authorization: Bearer <token>
Content-Type: application/json
X-Idempotency-Key: <uuid>  (for write operations)
```

### Standard Response Envelope

```typescript
interface ApiResponse<T> {
  data: T;
  meta?: { page: number; limit: number; total: number };
}

interface ApiError {
  error: {
    code: string;       // e.g., "GEOFENCE_OUT_OF_RANGE"
    message: string;    // Human-readable description
    details?: Record<string, unknown>;
  };
}
```

---

## 2. Module API Contracts

### 2.1 Authentication (`/auth`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| POST | `/auth/login` | `{ email, password }` | `{ token, user: { id, company_id, soffice_id, role_label, lini_ids, full_name } }` |
| POST | `/auth/logout` | — | `{ success: true }` |
| GET | `/auth/me` | — | `{ user: UserProfile }` |

### 2.2 Tenant Management (`/tenants`) — Super Admin only

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/tenants` | `?page, limit, search` | Paginated `Company[]` |
| POST | `/tenants` | `CreateCompanyInput` | `Company` |
| PATCH | `/tenants/:id` | `UpdateCompanyInput` | `Company` |
| PATCH | `/tenants/:id/deactivate` | — | `{ success: true }` |
| PUT | `/tenants/:id/erp-config` | `ERPConfigInput` | `Company` |

### 2.3 Attendance (`/attendance`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| POST | `/attendance/check-in` | `{ attendance_type, geom: {lat,lng}, photo_s3_key }` | `Absensi` |
| POST | `/attendance/check-out` | `{ geom: {lat,lng}, photo_s3_key? }` | `Absensi` |
| GET | `/attendance/today` | — | `Absensi \| null` |
| GET | `/attendance/history` | `?from, to, user_id?` | Paginated `Absensi[]` |

### 2.4 Customers (`/customers`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/customers` | `?type, soffice_id, search, page, limit` | Paginated `Customer[]` |
| GET | `/customers/:id` | — | `Customer` with PIC & doctor profiles |
| POST | `/customers` | `CreateCustomerInput` | `Customer` |
| PATCH | `/customers/:id` | `UpdateCustomerInput` | `Customer` |
| DELETE | `/customers/:id` | — | Soft-delete `{ success: true }` |
| POST | `/customers/bulk-import` | Multipart XLSX/CSV | `{ imported: number, errors: ImportError[] }` |

### 2.5 Doctors (`/doctors`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/doctors` | `?specialization, search, page, limit` | Paginated `DoctorWithProfile[]` |
| GET | `/doctors/:id` | — | Doctor profile + outlet assignments |
| POST | `/doctors/:id/assignments` | `{ outlet_customer_id, room, is_primary, days, hours }` | `DoctorOutletAssignment` |
| PATCH | `/doctors/:id/assignments/:assignmentId` | Update fields | `DoctorOutletAssignment` |
| DELETE | `/doctors/:id/assignments/:assignmentId` | — | Soft-delete |

### 2.6 Lini & Varian (`/lini`, `/varian`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/lini` | `?search, is_active, page, limit` | Paginated `MasterLini[]` |
| POST | `/lini` | `{ code, name, description }` | `MasterLini` |
| PATCH | `/lini/:id` | Update fields | `MasterLini` |
| DELETE | `/lini/:id` | — | Soft-delete |
| GET | `/varian` | `?search, is_active, page, limit` | Paginated `MasterVarian[]` |
| POST | `/varian` | `{ code, name, description }` | `MasterVarian` |
| PATCH | `/varian/:id` | Update fields | `MasterVarian` |
| DELETE | `/varian/:id` | — | Soft-delete |

### 2.7 User-Lini Assignments (`/users/:id/lini`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/users/:id/lini` | — | `UserLiniAssignment[]` |
| POST | `/users/:id/lini` | `{ lini_ids: uuid[] }` | `{ assigned: number }` |
| DELETE | `/users/:id/lini/:liniId` | — | `{ success: true }` |

### 2.8 Visit Plans (`/call-plans`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/call-plans` | `?user_id, month, year, page, limit` | Paginated `VisitPlan[]` |
| POST | `/call-plans/bulk-upload` | `VisitPlan[]` array | `{ created: number, errors: [] }` |
| GET | `/call-plans/today` | — | `VisitPlan[]` for current user today |
| GET | `/call-plans/analytics` | `?soffice_id, month, year` | `CallRateAnalytics` (segmented by role) |

### 2.9 Visits (`/visits`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| POST | `/visits/start` | `{ customer_id, outlet_id?, geom, visit_type }` | `Visit` (visit_in recorded) |
| POST | `/visits/:id/end` | `{ geom, signature_s3_key }` | `Visit` (visit_out recorded) |
| POST | `/visits/:id/agendas` | `{ topic, product_id?, summary, photo_s3_key? }` | `VisitAgenda` |
| POST | `/visits/:id/stock-audits` | `{ material_id, qty, uom, est_days }` | `VisitStockAudit` |
| POST | `/visits/:id/competitor-audits` | `{ brand, product, price, promo, photo_s3_key? }` | `VisitCompetitorAudit` |
| GET | `/visits` | `?date, user_id, customer_id, page, limit` | Paginated `Visit[]` |
| GET | `/visits/:id` | — | Full visit with agendas, audits, order |

### 2.10 Orders (`/orders`) — SALESMAN only

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| POST | `/orders` | `CreateOrderInput` (header + items[]) | `Order` with computed totals |
| GET | `/orders` | `?status, date_from, date_to, page, limit` | Paginated `Order[]` |
| GET | `/orders/:id` | — | `Order` with items + ERP sync status |
| POST | `/orders/:id/submit` | — | Triggers ERP sync job, status → `SUBMITTED` |
| GET | `/orders/:id/pdf` | — | Pre-signed S3 URL for PDF download |

**Note**: All `/orders` write endpoints (`POST`, `POST /:id/submit`) return `403 Forbidden` for `MR` role. Read endpoints are restricted to `SALESMAN` + admin roles via RLS.

### 2.11 Materials & Pricing (`/materials`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/materials` | `?lini_id, search, page, limit` | Paginated `Material[]` (filtered by user's lini assignments for field roles) |
| GET | `/materials/:id` | — | `Material` with UOM conversion rules |
| GET | `/materials/:id/price` | `?soffice_id, varian_id` | Current `Price` for branch + variant |
| GET | `/materials/:id/stock` | `?soffice_id, varian_id` | Current `StockATP[]` with batch & SLED |
| GET | `/promotions` | `?active=true` | Active `Promotion[]` |

**Note**: Both `SALESMAN` and `MR` can access material/price/stock read endpoints. Lini-scoped filtering is enforced by RLS.

### 2.12 ERP Sync (`/erp`) — System/Webhook

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| POST | `/erp/webhook/customers` | ERP customer delta payload | `{ processed: number }` |
| POST | `/erp/webhook/materials` | ERP SKU delta payload | `{ processed: number }` |
| POST | `/erp/webhook/prices` | ERP price list payload | `{ processed: number }` |
| POST | `/erp/webhook/stock` | ERP ATP payload (with batch & SLED) | `{ processed: number }` |
| POST | `/erp/webhook/promotions` | ERP promo payload | `{ processed: number }` |
| POST | `/erp/webhook/leads` | New customer/doctor leads | `{ plans_created: number }` |

### 2.13 Reports (`/reports`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/reports/dashboard-kpi` | `?soffice_id, period` | `DashboardKPI` (Salesman vs MR segmented) |
| GET | `/reports/branch-performance` | `?month, year` | `BranchPerformance[]` |
| GET | `/reports/call-rate` | `?user_id, soffice_id, month, role?` | `CallRateReport` |
| GET | `/reports/orders` | `?filters...` | Paginated order report |
| GET | `/reports/fraud-incidents` | `?user_id, date_from, date_to` | `FraudIncident[]` |
| GET | `/reports/export/:type` | `?format=xlsx\|pdf, filters...` | Streaming file download |

### 2.14 Uploads (`/uploads`)

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| POST | `/uploads/presigned-url` | `{ category, content_type, extension }` | `{ url, key, expires_in }` |

---

## 3. State Models & Enums

### 3.1 PostgreSQL Enum Types

```typescript
type ERPSystemType = 'SAP_S4HANA' | 'SAP_ECC' | 'QAD' | 'CUSTOM_REST';
type UserRole = 'SUPER_ADMIN' | 'ADMIN_PUSAT' | 'ADMIN_CABANG' | 'SALESMAN' | 'MR';
type AttendanceType = 'OFFICE' | 'CUSTOMER' | 'OTHER';
type CustomerType = 'OUTLET' | 'DOCTOR' | 'COMMUNITY' | 'EVENT';
type VisitType = 'PLANNED' | 'EXTRA';
type SyncStatus = 'PENDING' | 'SYNCED' | 'FAILED';
type OrderStatus = 'DRAFT' | 'SUBMITTED' | 'SYNCED_ERP' | 'REJECTED_ERP' | 'CANCELLED';
type PromoType = 'PERCENT_DISCOUNT' | 'FIXED_AMOUNT' | 'FREE_GOODS' | 'BUNDLING';
type FraudType = 'MOCK_LOCATION' | 'VELOCITY_ANOMALY' | 'ACCURACY_EXCESS' | 'CLOCK_DRIFT';
```

### 3.2 Visit Lifecycle State Machine

```
[SCHEDULED] → [IN_VISIT] → [COMPLETED]
                  ↓
        Activities (parallel):
        - Detailing/Agenda (Salesman & MR)
        - Competitor Audit (Salesman & MR)
        - Merchandising Audit (Salesman & MR)
        - Stock Audit (Salesman & MR)
        - Taking Order (Salesman ONLY)
        - Price/Stock Lookup (MR read-only)
                  ↓
        → Signature → Visit Out → [COMPLETED]
```

### 3.3 Order Status State Machine

```
[DRAFT] → [SUBMITTED] → [SYNCED_ERP]
                ↓              ↓
         [CANCELLED]    [REJECTED_ERP] → retry → [SUBMITTED]
```

### 3.4 Offline Sync State Machine

```
[PENDING] → [SYNCING] → [SYNCED]
                ↓
            [FAILED] → retry → [SYNCING]
```

---

## 4. Database Schema Summary

Full DDL is defined in `infra/postgres/init-scripts/`. Drizzle ORM schemas in `services/api-server/src/db/schema/`. Key tables by module:

### Tenancy & Organization
- `companies` — Tenant root with ERP config, branding, geofence defaults
- `master_soffice` — Branch sales offices per tenant
- `master_lini` — Business lines (e.g., FARMA_ETHICAL, OTC, ALKES)
- `master_varian` — Product variant/packaging tiers (e.g., REGULAR, TENDER)

### Users & Attendance
- `app_users` — All users with role (`SALESMAN` | `MR` | admin roles), company, branch assignment
- `user_lini_assignments` — M:N junction for user-to-business-line scoping
- `absensi` — Daily attendance records with GPS + photo

### Customer & Doctor
- `master_customer` — Unified customer (`OUTLET` | `DOCTOR` | `COMMUNITY` | `EVENT`)
- `doctor_profiles` — 1:1 extension for doctor specialization/schedule
- `doctor_outlet_assignments` — M:N doctor-to-outlet practice links
- `master_pic` — Outlet staff contacts

### Products & Pricing
- `master_material` — SKU catalog with UOM conversion rules, `lini_id` reference, NIE, manufacturer
- `master_price` — Branch + variant-specific pricing with validity dates and `per` unit
- `stock_inventory_atp` — Available-to-Promise stock from ERP with batch number & SLED
- `master_promotions` — Active promotion programs with UOM references

### Visits & Call Plans
- `visit_plans` — Monthly scheduled visits (MVP/SCP) for Salesman & MR
- `visits` — Executed visit records with geofence data
- `visit_agendas` — Detailing/meeting notes per visit
- `visit_stock_audits` — Shelf stock observations
- `visit_competitor_audits` — Competitor intelligence logs

### Orders (Salesman exclusive)
- `orders` — Order headers with totals, tax, ERP sync status
- `order_items` — Line items with pricing, variant, and promo references

### Audit
- `audit_mutation_logs` — Application-level change tracking
- `audit_fraud_telemetry` — GPS/clock fraud events
- `audit_erp_sync_logs` — ERP integration audit trail

### Reporting
- `mv_daily_branch_performance` — Materialized view for dashboard KPIs (segmented by Salesman vs MR visits)

---

## 5. Client-Side Offline Database (Dexie.js)

Located at `apps/field-pwa/database/index.ts`:

### Tables & Indexes

| Table | Primary Key | Secondary Indexes |
|-------|-------------|-------------------|
| `customers` | `[company_id+id]` | `company_id`, `customer_type`, `soffice_id` |
| `doctor_profiles` | `[company_id+id]` | `[company_id+customer_id]`, `specialization` |
| `doctor_outlet_assignments` | `[company_id+id]` | `[company_id+doctor_customer_id]`, `[company_id+outlet_customer_id]` |
| `user_lini_assignments` | `[company_id+id]` | `[company_id+user_id]`, `lini_id` |
| `materials` | `[company_id+id]` | `[company_id+lini_id]`, `erp_material_code` |
| `visit_plans` | `[company_id+id]` | `[company_id+plan_date]`, `customer_id` |
| `outbox_mutations` | `[company_id+id]` | `sync_status`, `captured_at`, `user_role` |

### Outbox Mutation Interface

```typescript
interface LocalOutboxMutation {
  id: string;
  company_id: string;
  user_role: 'SALESMAN' | 'MR';
  mutation_type: MutationType;
  payload: Record<string, unknown>;
  captured_at: number;
  sync_status: 'PENDING' | 'SYNCING' | 'FAILED';
  retry_count: number;
}

type MutationType = 'CHECK_IN' | 'VISIT_IN' | 'VISIT_OUT' | 'AGENDA' | 'STOCK_AUDIT' | 'COMPETITOR_AUDIT' | 'ORDER_SUBMIT';
```

### Sync Strategy

1. On app launch (online): full master data sync → Dexie bulk put (customers, doctors, assignments, lini assignments, materials filtered by user lini, visit plans)
2. During field work: mutations saved to `outbox_mutations` with `sync_status: 'PENDING'` and `user_role` from JWT
3. On connectivity restore: Service Worker Background Sync triggers FIFO push
4. Conflict resolution: server timestamp wins; client re-fetches affected records
5. Role-adaptive sync: `ORDER_SUBMIT` mutations only created by `SALESMAN`; `MR` outbox never contains order mutations

---

## 6. Key TypeBox Validation Schemas (Backend)

### Check-In Schema

```typescript
const CheckInSchema = Type.Object({
  attendance_type: Type.Enum(AttendanceTypeEnum),
  geom: Type.Object({
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lng: Type.Number({ minimum: -180, maximum: 180 }),
  }),
  photo_s3_key: Type.String({ minLength: 1 }),
  accuracy_meters: Type.Number({ minimum: 0 }),
  mono_delta_ms: Type.Number(),
});
```

### Visit Start Schema

```typescript
const VisitStartSchema = Type.Object({
  customer_id: Type.String({ format: 'uuid' }),
  outlet_id: Type.Optional(Type.String({ format: 'uuid' })),
  visit_type: Type.Enum(VisitTypeEnum),
  geom: Type.Object({
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lng: Type.Number({ minimum: -180, maximum: 180 }),
  }),
  accuracy_meters: Type.Number({ minimum: 0 }),
  mono_delta_ms: Type.Number(),
});
```

### Create Order Schema (Salesman only)

```typescript
const CreateOrderSchema = Type.Object({
  customer_id: Type.String({ format: 'uuid' }),
  doctor_customer_id: Type.Optional(Type.String({ format: 'uuid' })),
  visit_id: Type.Optional(Type.String({ format: 'uuid' })),
  items: Type.Array(Type.Object({
    material_id: Type.String({ format: 'uuid' }),
    qty: Type.Integer({ minimum: 1 }),
    uom: Type.String({ minLength: 1 }),
    varian_id: Type.Optional(Type.String({ format: 'uuid' })),
    promotion_id: Type.Optional(Type.String({ format: 'uuid' })),
  }), { minItems: 1 }),
});
```

---

## 7. Real-Time & WebSocket Events (Future)

Reserved WebSocket channels for live features:

| Channel | Payload | Consumer |
|---------|---------|----------|
| `tracking:{soffice_id}` | `{ user_id, role_label, lat, lng, timestamp }` | Admin live tracking map (Salesman & MR) |
| `sync:{user_id}` | `{ status, pending_count }` | PWA sync indicator |
| `alerts:{soffice_id}` | `{ type, user_id, message }` | Admin fraud alert panel |

---

## 8. S3 Key Structure

```
{company_id}/
├── attendance/
│   └── {year}/{month}/{uuid}.jpg         # Check-in selfies (Salesman & MR)
├── visits/
│   ├── photos/{year}/{uuid}.jpg          # Detailing & audit photos
│   └── signatures/{year}/{uuid}.png      # Digital signatures
├── orders/
│   └── quotations/{year}/{uuid}.pdf      # Generated PDF quotations (Salesman only)
└── customers/
    └── bulk-imports/{year}/{uuid}.xlsx    # Upload archives
```
