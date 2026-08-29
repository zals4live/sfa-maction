# Requirements — KF Maction v2.0

This document defines the acceptance criteria for all modules using the **EARS** (Easy Approach to Requirements Syntax) notation pattern.

Reference: #[[file:docs/PRD_Maction_v2.md]]

---

## Module 1: Multi-Tenant Management

### FR-TEN-01: Tenant CRUD & Provisioning
- **When** a Super Admin submits a new company registration form, **the system shall** create a `companies` record with auto-generated UUID, validate unique `code`, and initialize the logical partition by `company_id`.
- **When** a Super Admin updates tenant details, **the system shall** persist changes to `companies` and log the mutation in `audit_mutation_logs`.
- **When** a Super Admin deactivates a tenant, **the system shall** set `is_active = false` and trigger the kill-switch (FR-TEN-05).

### FR-TEN-02: Tenant ERP Gateway Mapping
- **When** a Super Admin configures ERP settings for a tenant, **the system shall** store `erp_system_type`, `erp_endpoint_url`, `erp_auth_config` (encrypted JSONB), and `erp_company_code` on the `companies` record.
- **The system shall** support ERP types: `SAP_S4HANA`, `SAP_ECC`, `QAD`, `CUSTOM_REST`.

### FR-TEN-03: Drizzle Transactional RLS Enforcement
- **When** any API request is processed, **the system shall** wrap database calls in Drizzle transactions executing `SET LOCAL app.current_company_id = ?`, `SET LOCAL app.current_user_id = ?`, and `SET LOCAL app.current_user_role = ?` via the tenant-guard middleware before any database query.
- **The system shall** enforce PostgreSQL RLS policies on all tenant-scoped tables ensuring zero cross-tenant data access.

### FR-TEN-04: Tenant Dynamic Branding
- **When** a tenant has a configured `logo_s3_key`, **the system shall** render the tenant's logo on PDF quotations, admin portal header, and PWA splash screen.
- **The system shall** apply tenant-specific `default_tax_rate` and `geofence_radius_meters` defaults to all operations under that tenant.

### FR-TEN-05: Tenant Kill-Switch
- **When** a tenant's `is_active` is set to `false`, **the system shall** immediately invalidate all active Redis sessions for users under that `company_id` and block all subsequent login attempts.

---

## Module 2: Authentication, Security & Anti-Spoofing

### FR-AUTH-01: Tenant & Role Scoped JWT
- **When** a user successfully authenticates, **the system shall** issue a JWT containing `user_id`, `company_id`, `soffice_id`, `role_label` (`SUPER_ADMIN` | `ADMIN_PUSAT` | `ADMIN_CABANG` | `SALESMAN` | `MR`), and `lini_ids` (array of assigned business line UUIDs).
- **The system shall** set token expiry to 24 hours for field force (`SALESMAN`, `MR`) and 8 hours for admin roles.

### FR-AUTH-02: Single Active Session
- **When** a user logs in from a new device/IP, **the system shall** invalidate the prior session token stored in Redis and update `app_users.current_session_ip`.
- **The system shall** return `401 Unauthorized` for any request using an invalidated token.

### FR-SEC-GPS-01: Mock Location Detection
- **When** the PWA captures a GPS position (for both `SALESMAN` and `MR`), **the system shall** inspect provider flags for mock indicators and validate accuracy is within 3m–50m range.
- **If** accuracy is outside the valid range, **the system shall** soft-reject the action and queue a fraud telemetry record.

### FR-SEC-GPS-02: Spatial Velocity Check
- **When** the server receives consecutive GPS-tagged requests from the same user, **the system shall** compute speed using PostGIS `ST_DistanceSphere` and elapsed time.
- **If** calculated speed exceeds 120 km/h, **the system shall** reject the request and log a `VELOCITY_ANOMALY` to `audit_fraud_telemetry`.

### FR-SEC-GPS-03: Anti-Clock Tamper Engine
- **When** the PWA records offline timestamps, **the system shall** anchor them against `performance.now()` monotonic deltas.
- **If** server-side delta comparison shows drift > 30 seconds, **the system shall** flag the record as `CLOCK_DRIFT` fraud type.

### FR-SEC-GPS-04: Graduated Fraud Response
- **When** a location anomaly is detected, **the system shall** soft-reject the current action, display a non-aggressive user dialog, and log telemetry without hard-banning the user.

---

## Module 3: Daily GPS Attendance Management

### FR-ATT-01: Multi-Category Check-In
- **When** a field user (Salesman or MR) initiates check-in, **the system shall** require selection of category: `OFFICE`, `CUSTOMER`, or `OTHER`.
- **The system shall** validate the `attendance_type` enum before persisting.

### FR-ATT-02: PostGIS Geofence Validation
- **When** a check-in is submitted with category `OFFICE`, **the system shall** compute distance between the submitted GPS point and the branch `master_soffice.location_geom` using `ST_DWithin`.
- **The system shall** record `check_in_distance_meters` on the `absensi` record.

### FR-ATT-03: Selfie Capture & S3 Storage
- **When** a check-in is initiated, **the system shall** require a mandatory camera capture.
- **The system shall** overlay timestamp and GPS watermark on the client side, then upload the photo to S3 via a pre-signed URL.
- **The system shall** store the resulting S3 key in `absensi.check_in_photo_s3_key`.

### FR-ATT-04: Attendance Locking Engine
- **If** no valid `absensi` record exists for the current user and `attendance_date = TODAY`, **the system shall** disable all field visit execution features.
- **The system shall** display a lock notice directing the user to complete check-in first.
- **This applies equally to both `SALESMAN` and `MR` roles.**

### FR-ATT-05: Conditional Checkout Rule
- **The system shall** enable check-out only after 16:00 local time or shift completion.
- **When** a user checks out, **the system shall** lock all visit actions for the remainder of that day.

---

## Module 4: Master Hierarchy, Multi-Lini Scoping & Doctor-Outlet Affiliations

### FR-MST-01: Customer 360 View (Outlet & Doctor)
- **The system shall** support a unified `master_customer` table with `customer_type` discriminator: `OUTLET` (physical facility) or `DOCTOR` (doctor entity).
- **When** viewing a customer profile, **the system shall** display full details including PIC contacts, geolocation, credit info, and — for doctors — specialization and practice schedule.
- **Both Salesmen and MRs have complete visibility to Outlets and Doctors.**

### FR-MST-02: Doctor Multi-Outlet Affiliation (1:N)
- **When** a doctor is assigned to an outlet, **the system shall** create a `doctor_outlet_assignments` record linking `doctor_customer_id` to `outlet_customer_id` with room/department, practice days, hours, and primary practice flag.
- **The system shall** support one doctor affiliated with multiple outlets.

### FR-MST-03: Geofence Inheritance for Doctor Visits
- **When** a field user (Salesman or MR) initiates a visit to a doctor at a specific outlet, **the system shall** dynamically resolve the geofence coordinates from the target outlet's `location_geom` — not from the doctor entity.

### FR-MST-04: Multi-Lini Business Assignment (M:N)
- **The system shall** support assigning field users (Salesman and MR) to one or more business lines via `user_lini_assignments`.
- **The system shall** enforce via PostgreSQL RLS that field users only see materials matching their assigned `lini_id` values, whereas `ADMIN_PUSAT` and `ADMIN_CABANG` have complete access.

### FR-MST-05: Lini & Varian Master Data Management
- **The system shall** provide CRUD for `master_lini` (business lines) and `master_varian` (product variants/packaging tiers) scoped by `company_id`.
- **The system shall** enforce unique codes per tenant with soft-delete support.

### FR-MST-06: Material Master Compliance & Supply Chain
- **The system shall** store comprehensive material attributes including BPOM license (`nie`, `valid_nie`), manufacturer, brand principal, separate `base_uom` and `sales_uom`, `lini_id` reference, and JSONB UOM conversion matrix.
- **The system shall** flag narcotic/psychotropic materials via `is_narcotic_psychotropic`.

### FR-MST-07: Batch & Expiration (SLED) Inventory
- **The system shall** track inventory in `stock_inventory_atp` partitioned by `company_id`, branch `soffice`, `varian_id`, batch number, and shelf life expiration date (`sled`).

### FR-MST-08: PostGIS Spatial Pinpoint
- **The system shall** store customer locations as `geometry(Point, 4326)` with a GIST spatial index.
- **When** Admin Pusat recalibrates coordinates, **the system shall** update `location_geom` and log the change in audit.

### FR-MST-09: Soft-Delete Architecture
- **When** a customer/doctor/assignment is deleted, **the system shall** set `is_deleted = true`, `deleted_at = NOW()`, `deleted_by = current_user_id`.
- **The system shall** maintain partial unique indexes that exclude soft-deleted records.

### FR-MST-10: Bulk Import via Spreadsheet
- **When** an admin uploads a spreadsheet (XLSX/CSV), **the system shall** validate schema, reject invalid rows with error details, and batch-insert valid records via Elysia.js streaming.

---

## Module 5: Sales Call Plan (SCP/MVP)

### FR-SCP-01: Monthly Visit Plan Upload
- **When** a Branch Admin uploads a monthly call schedule, **the system shall** create `visit_plans` records mapping each salesman or MR to target customers/doctors with planned dates and outlet context.
- **The system shall** enforce the unique constraint `(company_id, user_id, customer_id, outlet_context_id, plan_date)`.

### FR-SCP-02: Visit Type Classification
- **When** a visit matches an existing `visit_plans` record for the user/customer/date, **the system shall** classify it as `PLANNED`.
- **If** no matching plan exists, **the system shall** classify the visit as `EXTRA`.

### FR-SCP-03: Call Rate Target Analytics
- **The system shall** calculate Call Rate as: `(Actual Visits / Target MVP Visits) × 100%`.
- **The system shall** provide this metric at user, branch, and tenant levels in real time.
- **The system shall** calculate call rate independently for Salesmen and MRs.

---

## Module 6: Field Visit Execution & In-Visit Lifecycle

### FR-VST-01: Visit In Geofence Check
- **When** a field user (Salesman or MR) taps "Visit In", **the system shall** validate that the device GPS is within the configured geofence radius (default 100m) of the target outlet's `location_geom`.
- **If** out of range, **the system shall** disable the Visit In button and display the distance gap.

### FR-VST-02: Concurrent Visit Lock
- **If** a user has an open visit (Visit In without Visit Out), **the system shall** prevent starting a new visit until the prior visit is completed.

### FR-VST-03: Agenda & Detailing Logging
- **When** a field user (Salesman or MR) records an agenda item, **the system shall** persist topic, product discussed, discussion summary, and mandatory photo (S3) in `visit_agendas`.

### FR-VST-04: Competitor Intelligence
- **When** a field user logs competitor data, **the system shall** capture brand, product, price points, promo notes, and photo in `visit_competitor_audits`.

### FR-VST-05: Merchandising & Planogram Audit
- **When** a field user performs a merchandising audit, **the system shall** record display compliance observations with before/after photos stored in S3.

### FR-VST-06: Outlet Stock on Hand & Branch ATP Check
- **When** a field user (Salesman or MR) audits shelf stock, **the system shall** capture physical stock quantity per SKU, UOM, and estimated days of stock in `visit_stock_audits`.
- **Both Salesman and MR can view live branch warehouse ATP stock.**

### FR-VST-07: Digital Signature & Visit Out
- **When** a doctor/PIC signs on the signature canvas, **the system shall** save the signature image to S3 and store the key in `visits.signature_s3_key`.
- **When** Visit Out is submitted, **the system shall** record `visit_out_at` timestamp (monotonic-anchored) and `visit_out_geom` coordinates.

---

## Module 7: SFA & Order Taking

### FR-SFA-01: Salesman Exclusive Order Taking
- **The system shall** restrict Taking Order, Shopping Cart, By-Phone Sales, and Draft Quotation generation **strictly to users with `role_label = 'SALESMAN'`**.
- **The system shall** return `403 Forbidden` for any `MR` user attempting order creation endpoints.

### FR-SFA-02: MR Pricing & Stock Lookup (No Orders)
- **Users with `role_label = 'MR'` shall** be granted full read access to product price lists (`master_price`) and branch stock availability (`stock_inventory_atp`) to facilitate medical consultations.
- **The system shall** strictly forbid MR from creating orders — `POST /orders` returns `403 Forbidden`.

### FR-SFA-03: Outlet & Doctor Order Association
- **Salesmen can** create orders for direct Outlets or orders referencing a prescribing Doctor at a specific practicing Outlet facility.

### FR-SFA-04: On-Site & By-Phone Ordering
- **The system shall** support order creation both during physical visits (linked to `visit_id`) and via a standalone By-Phone Sales module (no visit link required).

### FR-SFA-05: Multi-Tier UOM Conversion
- **When** a salesman selects a UOM for an order item, **the system shall** apply conversion rules from `master_material.uom_conversion_rules` JSON (e.g., `{"base_uom": "TABLET", "conversions": {"KARTON": 1000, "BOX": 100, "STRIP": 10, "TABLET": 1}}`).

### FR-SFA-06: Regional Price Tiering
- **When** calculating item price, **the system shall** look up `master_price` filtered by the user's `soffice_id`, `material_id`, `varian_id`, and current validity date range.
- **The system shall** apply the `per` unit quantity for price computation.

### FR-SFA-07: Automated Tax Calculation
- **The system shall** compute: `tax_amount = subtotal_after_discount × tax_rate` where `tax_rate` defaults to tenant's `default_tax_rate` (11% PPN).
- **The system shall** calculate `grand_total = subtotal - total_discount + tax_amount`.

### FR-SFA-08: Digital Quotation Generation
- **When** an order is finalized, **the system shall** generate a PDF quotation with tenant branding, customer details, itemized prices, discounts, PPN, and PIC/Doctor signature.
- **The system shall** upload the PDF to S3 and store the key in `orders.pdf_quotation_s3_key`.

---

## Module 8: PWA & Offline Data Synchronization

### FR-PWA-01: PWA App Shell & Installation
- **The system shall** provide a standalone installable PWA via `@vite-pwa/nuxt` with Web App Manifest containing tenant-configurable icons and splash screens.

### FR-PWA-02: Static Asset Precaching
- **The system shall** precache core UI assets (CSS, JS, fonts, icons) using Workbox with Stale-While-Revalidate strategy.

### FR-PWA-03: Compound IndexedDB Caching
- **When** the PWA is online, **the system shall** sync master data (Customers, Doctors, Doctor-Outlet Assignments, User-Lini Assignments, Materials, Prices, Visit Plans) into Dexie.js with compound primary key `[company_id+id]`.

### FR-PWA-04: Role-Adaptive Offline Execution
- **When** the device is offline, **the system shall** allow complete execution of: Check-In, Visit In, Detailing, Stock Audit, Competitor Audit, Signatures, and Visit Out — persisting all data locally.
- **For `SALESMAN`**: the system shall additionally support Taking Order with cart outbox mutation.
- **For `MR`**: the system shall skip cart/order outbox mutation and provide read-only price/stock lookup from cached data.

### FR-PWA-05: Offline GPS & Monotonic Clock
- **When** offline, **the system shall** capture device GPS and anchor timestamps with `performance.now()` deltas stored alongside `Date.now()` values.

### FR-PWA-06: Background Auto-Sync Queue
- **When** connectivity is restored, **the system shall** trigger Background Sync API to push all pending `outbox_mutations` (status `PENDING`) to the Elysia.js API in FIFO order.
- **The system shall** update `sync_status` to `SYNCING` during transmission and `SYNCED` or `FAILED` upon completion.
- **Outbox mutations include a `user_role` field** to enable role-specific server-side validation during sync.

### FR-PWA-07: Visual Connectivity & Sync State
- **The system shall** display a persistent top navbar indicator showing: `Online` (green), `Offline` (amber with pending count), `Syncing` (blue with progress), or `Error` (red with retry option).

---

## Module 9: ERP Integration

### FR-ERP-01: New Leads → SFA Visit Plan
- **When** an ERP webhook delivers a new validated customer/doctor lead, **the system shall** auto-generate a `visit_plans` record assigning the lead to the relevant branch salesman or MR.

### FR-ERP-02: SFA Order → ERP Sales Quotation
- **When** an order is submitted (status `SUBMITTED`), **the system shall** enqueue a BullMQ job to push the order payload to the tenant's ERP endpoint as a Draft Sales Quotation.
- **The system shall** include an `idempotency_key` and update `orders.order_status` to `SYNCED_ERP` on success or `REJECTED_ERP` on failure.

### FR-ERP-03: Sync Master Customer & Doctor
- **When** an inbound delta sync is received from ERP, **the system shall** upsert `master_customer` and `doctor_profiles` records matching on `erp_customer_code`.

### FR-ERP-04: Sync Master Product / SKU & Lini
- **When** an inbound SKU sync is received, **the system shall** upsert `master_material` records matching on `erp_material_code`, including `lini_id` references.

### FR-ERP-05: Sync Stock Availability with Batch & SLED
- **When** stock sync data is received, **the system shall** update `stock_inventory_atp` for the matching `(company_id, soffice_id, material_id, varian_id, batch)` tuple, including shelf life expiration date (`sled`).

### FR-ERP-06: Sync Product Pricing & Variants
- **When** pricing data is received from ERP, **the system shall** upsert `master_price` records for the matching branch, material, and varian with valid date ranges and `per` unit.

### FR-ERP-07: Sync Master Discount Rules
- **When** discount rule data is received, **the system shall** update the SFA pricing engine with tiered regular, volume, and segment discounts.

### FR-ERP-08: Sync Master Promotion Programs
- **When** promotion data is received, **the system shall** upsert `master_promotions` with type, discount/free goods config, validity dates, min order quantities, and UOM references.

---

## Module 10: Maps & Spatial Visualization

### FR-MAP-01: PWA Geofence Radar View
- **When** a field user (Salesman or MR) views a visit target, **the system shall** render a Leaflet map with: the target outlet's geofence circle, a pulsing marker for the rep's live position, and dynamic distance label.

### FR-MAP-02: Daily Route Polyline
- **When** a field user opens the route view, **the system shall** display scheduled visit locations connected by polylines with Turf.js geodesic distance calculation.

### FR-MAP-03: Location Pin Picker
- **When** an admin creates or recalibrates a customer location, **the system shall** provide an interactive Leaflet map picker modal to set precise coordinates.

### FR-MAP-04: Admin Live Tracking & Breadcrumbs
- **When** an Admin Cabang opens the tracking page, **the system shall** display real-time positions of active sales reps and MRs with chronological GPS breadcrumb trails on a Leaflet map.

### FR-MAP-05: Territory & Customer Clustering
- **The system shall** render territory maps using `leaflet.markercluster` to visualize outlet/doctor coverage density per branch.

### FR-MAP-06: Admin Visual GPS Recalibration
- **When** an admin drags a customer pin to a new position, **the system shall** update `master_customer.location_geom` and log the coordinate change in audit.

---

## Module 11: Audit & Fraud Telemetry

### FR-AUD-01: Application Activity & Delta Audit
- **When** any write operation occurs, **the system shall** record entity name, record ID, action type, before/after JSON states, user ID, and client IP in `audit_mutation_logs`.

### FR-AUD-02: Fraud Telemetry Logging
- **When** a GPS anomaly is detected (mock, velocity, accuracy, clock drift), **the system shall** persist the full event with device info and payload snapshot in `audit_fraud_telemetry`.

### FR-AUD-03: ERP Sync Audit Trail
- **When** an ERP sync operation completes, **the system shall** log direction, endpoint URL, request/response payloads, HTTP status, latency, retry count, and success flag in `audit_erp_sync_logs`.

### FR-AUD-04: Visit Lifecycle Audit Stream
- **The system shall** maintain granular timestamp records across the full visit lifecycle: check-in → arrival → detailing duration → order entry (Salesman only) → signing → visit out.

---

## Module 12: Executive Dashboard & Reporting

### FR-REP-01: Executive KPI Summary Dashboard
- **The system shall** display real-time aggregate metrics: Total Effective Calls (Salesman vs MR segmented), Call Rate Realization (%), Total Sales Revenue (Draft vs Synced), and Active Field Reps count.
- **The system shall** serve dashboard data from Redis-cached materialized views (TTL 5-15 min).

### FR-REP-02: Role-Segmented Performance Matrix
- **The system shall** provide comparative league tables ranking branches, Salesmen (by revenue, visits, strike rate), and MRs (by call rate, detailing coverage, doctor reach) with trend graphs.

### FR-REP-03: Territory & Coverage White-Spot Analytics
- **The system shall** render Leaflet heatmaps highlighting outlet/doctor coverage intensity versus unvisited accounts.

### FR-REP-04: Medical Detailing & Product Trend Report
- **The system shall** consolidate detailing topics, products discussed per doctor specialty and business line, and prescription correlation with outlet orders.

### FR-REP-05: Competitor Intelligence Digest
- **The system shall** aggregate competitor pricing, trade promotions, and market share trends from in-visit audit data.

### FR-REP-06: Granular SFA Order & Quotation Report
- **The system shall** provide a filterable transaction register: orders by SKU, variant, volume, discounts, taxes, sync status, and approving supervisor.

### FR-REP-07: Attendance & Geofence Fraud Incident Report
- **The system shall** summarize check-in punctuality, distance variances, and GPS mock/teleportation incidents per rep (Salesman and MR).

### FR-REP-08: High-Throughput Export to Excel & PDF
- **When** an admin requests a report export, **the system shall** stream the dataset via Elysia.js streaming endpoint into formatted `.xlsx` or executive PDF without blocking the event loop.

---

## Non-Functional Requirements

### NFR-PERF-01: PWA Offline Write Latency
- **The system shall** complete local IndexedDB (Dexie.js) transaction writes within ≤ 50ms.

### NFR-PERF-02: Map Rendering
- **The system shall** load and render interactive Leaflet maps within ≤ 500ms on standard mobile devices.

### NFR-PERF-03: API Response Time
- **The system shall** respond to Elysia.js + Drizzle ORM HTTP endpoints within ≤ 100ms at the 95th percentile.

### NFR-PERF-04: Geospatial Processing
- **The system shall** execute PostGIS `ST_DWithin` geofence calculations within ≤ 15ms.

### NFR-PERF-05: Dashboard Aggregation
- **The system shall** serve materialized view cached dashboard responses within ≤ 150ms.

### NFR-AVAIL-01: System Uptime
- **The system shall** maintain ≥ 99.9% operational uptime during field business hours (06:00–21:00 WIB).

### NFR-SEC-01: Transport Encryption
- **The system shall** enforce TLS 1.3 for all client-server communication via Nginx termination.

### NFR-SEC-02: Idempotent ERP Sync
- **The system shall** include a unique `idempotency_key` on all outbound ERP requests, processed via Redis to prevent duplicate Sales Quotations.

### NFR-UI-01: Forced Light Mode
- **The system shall** enforce light-only color mode (`preference: 'light'`, `fallback: 'light'`) across both PWA and Web Portal for maximum outdoor readability. Dark mode is explicitly disabled.
