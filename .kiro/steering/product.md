# Product Domain & Business Context

This steering file defines the business domain, organizational hierarchy, user personas, and domain glossary for **KF Maction v2.0** — an enterprise Sales Force Automation (SFA) and Field Force Activity Monitoring platform for PT Kimia Farma Tbk.

---

## Organization & Tenancy Hierarchy

KF Maction operates as a **multi-tenant shared-schema** system partitioned by `company_id`. The holding company (KFHO) governs all tenants.

```
PT Kimia Farma Tbk (Holding - KFHO)
├── KFTD (Kimia Farma Trading & Distribution)
├── KFSP (Kimia Farma Apotek / Sungwun Pharmacopia)
├── KFA  (Kimia Farma Apotek retail chain)
└── Future Subsidiaries...
```

Each tenant has:
- Multiple **Sales Offices (soffice)** representing branch locations
- Users scoped to a specific `company_id` + `soffice_id`
- Independent ERP gateway configurations per tenant
- Configurable geofence radius, tax rates, and branding
- Multiple **Business Lines (Lini)** with user-level multi-lini assignments (M:N)

---

## User Personas & Roles (RBAC)

| Role ID | Role Label | Platform | Scope |
|---------|-----------|----------|-------|
| ROL-01 | `SUPER_ADMIN` | Web Portal `/admin/super` | Cross-tenant governance, tenant provisioning, ERP config, system settings. Full bypass access to all materials and lines across all tenants. |
| ROL-02 | `ADMIN_PUSAT` | Web Portal `/admin/tenant` | Tenant-wide master data, executive dashboards, reporting, national oversight. Full access to all business lines within the tenant. |
| ROL-03 | `ADMIN_CABANG` | Web Portal `/admin/cabang` | Branch-level SCP approval, live GPS tracking (Salesman & MR), fraud alert review, branch analytics across all branch lines. |
| ROL-04 | `SALESMAN` | Nuxt PWA `/app` | Daily attendance, offline visit execution (Outlets & Doctors), order taking, geofence radar, digital signatures. Full access to Price lists, Stock ATP, and Taking Order scoped to assigned business lines. |
| ROL-05 | `MR` | Nuxt PWA `/app` | Daily attendance, offline visit execution (Outlets & Doctors), medical detailing, promotional presentation, competitor intelligence, outlet stock audit. Read access to Price lists & Stock ATP for consultation. **Strictly RESTRICTED from Taking Order / Cart / Sales Quotation creation.** |

### Role Boundary Rules

- `SALESMAN` and `MR` share the same PWA but see role-adaptive in-visit workflows
- `MR` sees a "Product Info & Stock" step instead of "Taking Order" step
- Order API endpoints (`POST /orders`) return `403 Forbidden` for `MR` role
- Both `SALESMAN` and `MR` can visit Outlets and Doctors with full detailing capabilities
- Material catalog access is scoped by `user_lini_assignments` for both field roles

---

## Core Business Modules

1. **Multi-Tenant Management** — Tenant CRUD, ERP gateway mapping, RLS enforcement, kill-switch
2. **Authentication & Anti-Spoofing** — JWT auth, single session, mock location detection, velocity checks
3. **GPS Attendance** — Multi-category check-in/out (Salesman & MR), selfie + S3, geofence validation, time locks
4. **Master Hierarchy & Multi-Lini Scoping** — Lini & Varian management, user multi-lini assignment (M:N), RLS-enforced material access
5. **Customer & Doctor Management** — Unified Outlet/Doctor model, doctor multi-outlet affiliation (1:N), PIC contacts
6. **Sales Call Plan (SCP/MVP)** — Monthly visit plan upload (Salesman & MR), planned vs extra visits, call rate analytics
7. **Field Visit Execution** — Visit In/Out lifecycle (Salesman & MR), detailing, competitor audit, stock audit, merchandising, digital signature
8. **SFA & Order Taking** — Salesman-exclusive on-site and by-phone orders, UOM conversion, regional pricing, tax calc, PDF quotation. MR gets read-only price/stock lookup.
9. **PWA & Offline Sync** — App shell, Workbox precaching, Dexie.js compound indexing, role-adaptive offline workflows, background sync queue
10. **ERP Integration** — Inbound master sync (customer, SKU, price, promo, stock ATP with batch/SLED), outbound order-to-quotation via BullMQ
11. **Maps & Spatial Visualization** — Leaflet geofence radar, route polyline, live tracking (Salesman & MR), marker clustering
12. **Audit & Fraud Telemetry** — Mutation logs, fraud telemetry, ERP sync audit, visit lifecycle audit
13. **Executive Dashboard & Reporting** — KPI cards (Salesman vs MR segmented), branch performance matrix, territory analytics, Excel/PDF export

---

## Domain Glossary

| Term | Definition |
|------|-----------|
| **MVP / SCP** | Monthly Visit Plan / Sales Call Plan — scheduled customer visits per salesman/MR per month |
| **Effective Call (EC)** | A completed visit with all mandatory activities fulfilled |
| **Call Rate** | `(Actual Visits / Target MVP Visits) × 100%` — calculated independently for Salesman and MR |
| **Soffice** | Sales Office — a branch location within a tenant company |
| **Outlet** | A physical customer location (Apotek, Rumah Sakit, Klinik) — `customer_type = 'OUTLET'` |
| **Doctor** | A doctor entity in `master_customer` with `customer_type = 'DOCTOR'` |
| **Doctor-Outlet Assignment** | M:N junction linking a doctor to one or more practice outlets via `doctor_outlet_assignments` |
| **PIC** | Person In Charge — staff contact at an outlet (e.g., pharmacist, purchasing) |
| **Visit In / Visit Out** | The geofence-validated start and signed end of a field visit |
| **Outbox** | Local Dexie.js queue of offline mutations awaiting background sync |
| **ATP** | Available-to-Promise — unrestricted stock quantity from ERP warehouse |
| **UOM** | Unit of Measure — hierarchical conversion (Karton → Box → Strip → Pcs) |
| **RLS** | Row-Level Security — PostgreSQL policy enforcing `company_id` + role/lini isolation |
| **Geofence Radius** | Default 100m proximity threshold for visit validation |
| **Monotonic Clock** | `performance.now()` hardware clock used to detect local time manipulation |
| **BullMQ** | Redis-backed job queue for ERP sync with retry and exponential backoff |
| **PPN** | Pajak Pertambahan Nilai — Indonesian VAT at 11% |
| **Lini (Business Line)** | Product classification grouping (e.g., `FARMA_ETHICAL`, `FARMA_GENERIK`, `OTC`, `ALKES`) — stored in `master_lini` |
| **Varian** | Product variant/packaging tier (e.g., `REGULAR`, `TENDER`, `EXPORT`) — stored in `master_varian` |
| **SLED** | Shelf Life Expiration Date — batch-level expiry tracked in `stock_inventory_atp` |
| **NIE** | Nomor Izin Edar — BPOM regulatory license number for pharmaceutical products |
| **User-Lini Assignment** | M:N junction (`user_lini_assignments`) scoping which business lines a field user can access |

---

## Key Business KPIs

- **Visit Compliance**: ≥ 95% adherence to MVP verified via PostGIS geofencing (Salesman & MR independently)
- **Zero Field Downtime**: 100% operational availability offline via Dexie.js caching
- **Instant Quotation Processing**: Orders auto-pushed to ERP as Draft Sales Quotations (Salesman only)
- **Role Boundary Enforcement**: Order-taking exclusively for `SALESMAN`; `MR` gets informational access only
- **Granular Product Scoping**: Material access strictly enforced by user multi-lini assignments via RLS
- **Multi-Facility Doctor Intelligence**: Full visibility of Salesman & MR engaging doctors across multiple practice locations
- **Sub-second Dashboard Rendering**: Materialized view + Redis cache for KPI queries
- **Zero Cross-Tenant Leakage**: Guaranteed via PostgreSQL RLS + Elysia.js tenant middleware
