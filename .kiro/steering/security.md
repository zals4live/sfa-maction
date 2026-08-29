# Security Patterns & Enforcement

This steering file defines the security architecture, anti-spoofing mechanisms, and data protection policies for KF Maction v2.0.

---

## Multi-Tenant Isolation (Zero Cross-Tenant Leakage)

### PostgreSQL Row-Level Security (RLS)

- Every tenant-scoped table has RLS enabled
- Base policy pattern: `company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid`
- The Elysia.js tenant-guard middleware sets three session variables at the start of every request transaction:
  - `SET LOCAL app.current_company_id = ?`
  - `SET LOCAL app.current_user_id = ?`
  - `SET LOCAL app.current_user_role = ?`
- **Never bypass RLS** — no `SET ROLE` overrides or `SECURITY DEFINER` functions that skip tenant checks
- Super Admin operations that cross tenants must use a dedicated service connection without RLS (separate DB role)

### Lini-Scoped Material Access (RLS)

- `master_material` has a compound RLS policy that enforces both tenant isolation AND business line scoping:
  - `SUPER_ADMIN`: full bypass (all materials, all tenants via service connection)
  - `ADMIN_PUSAT` / `ADMIN_CABANG`: full access to all materials within their `company_id`
  - `SALESMAN` / `MR`: materials filtered by `lini_id IN (SELECT lini_id FROM user_lini_assignments WHERE user_id = app.current_user_id AND is_active = TRUE)`
- This ensures field users only see products matching their assigned business lines

### Orders Access Policy (RLS)

- `orders` table has RLS that restricts access to `SUPER_ADMIN`, `ADMIN_PUSAT`, `ADMIN_CABANG`, and `SALESMAN` roles only
- `MR` role is excluded from orders RLS policy — cannot read or write order records at the database level

### Tenant Context Enforcement

- JWT token includes `company_id` — validated against the request context on every call
- Tenant kill-switch (`companies.is_active = false`) invalidates all Redis sessions immediately
- All API queries must flow through the tenant-guard middleware — no direct DB access from route handlers

---

## Authentication & Session Security

### JWT Token Structure

```json
{
  "user_id": "uuid",
  "company_id": "uuid",
  "soffice_id": "uuid",
  "role_label": "SALESMAN",
  "lini_ids": ["uuid", "uuid"],
  "iat": 1700000000,
  "exp": 1700086400
}
```

### Session Rules

- **Single Active Session**: Only one active session per user — new login invalidates prior session via Redis
- Token stored in `HttpOnly` secure cookie (web portal) or encrypted local storage (PWA)
- Session IP tracked in `app_users.current_session_ip` — concurrent device detection
- Token expiry: 24 hours for field force (`SALESMAN`, `MR`), 8 hours for admin portal
- Refresh tokens: not used — re-authentication required after expiry

---

## RBAC Endpoint Authorization

### Role-Based Route Guards

- Order-taking endpoints (`POST /orders`, `POST /orders/:id/submit`, `GET /orders/:id/pdf`) require `role_label = 'SALESMAN'`
- `MR` attempting order endpoints receives `403 Forbidden` with structured error response
- Material price/stock endpoints (`GET /materials/:id/price`, `GET /materials/:id/stock`) are accessible by both `SALESMAN` and `MR`
- Admin portal endpoints require `ADMIN_CABANG`, `ADMIN_PUSAT`, or `SUPER_ADMIN`
- Cross-tenant endpoints (tenant CRUD, ERP config) require `SUPER_ADMIN` exclusively

---

## Anti-Spoofing & Geolocation Hardening

### Layer 1: Client-Side Mock Detection (PWA)

- Inspect OS-level location provider flags for mock indicators
- Enforce GPS accuracy threshold: `3m ≤ accuracy ≤ 50m`
- Reject coordinates with accuracy outside this range (soft rejection)
- Log rejection to local outbox for fraud telemetry sync
- Applies to both `SALESMAN` and `MR` field roles

### Layer 2: Monotonic Clock Anchoring

- Capture `performance.now()` hardware clock deltas alongside `Date.now()` timestamps
- Compare client-reported time deltas against server-observed request timing
- Flag clock drift > 30 seconds as `CLOCK_DRIFT` fraud type
- Offline timestamps validated against monotonic progression (no backwards jumps)

### Layer 3: Server-Side Velocity Check (Elysia.js)

- Calculate speed between consecutive GPS submissions using PostGIS `ST_DistanceSphere`
- Formula: `speed_kmh = (distance_meters / time_seconds) * 3.6`
- Threshold: speed > 120 km/h triggers `VELOCITY_ANOMALY` rejection
- Consecutive anomalies within a session escalate alert severity

### Graduated Fraud Response

- **Soft Rejection**: Block the current action (visit-in, check-in) but do not ban the user
- **Telemetry Logging**: Record incident in `audit_fraud_telemetry` with full device info and payload
- **User Notification**: Display non-aggressive dialog explaining GPS verification failure
- **No Immediate Hard Ban**: Fraud patterns are reviewed by Admin Cabang through the audit dashboard
- Escalation path: repeated soft rejections → Admin notified → manual investigation

---

## Input Validation & Data Sanitization

### Request Validation

- All request bodies validated via **TypeBox schemas** at the Elysia route level
- Reject malformed requests before they reach service logic
- String inputs: trim whitespace, enforce max length, reject dangerous characters
- Numeric inputs: validate ranges (e.g., qty > 0, discount_percentage 0-100)
- UUID params: validate format before database queries

### SQL Injection Prevention

- **Always** use parameterized queries via Drizzle ORM query builder
- Raw SQL only for PostGIS functions — still parameterized (`$1`, `$2` placeholders)
- Never concatenate user input into SQL strings

### File Upload Security

- Uploads go directly to S3 via pre-signed URLs (never through the API server)
- Pre-signed URLs scoped to: specific S3 key path, content-type restriction, max file size (10MB)
- S3 key structure: `{company_id}/{category}/{year}/{uuid}.{ext}`
- Allowed MIME types: `image/jpeg`, `image/png`, `image/webp` (photos); `application/pdf` (quotations)

---

## Credential & Secret Management

### Environment Variables (Required)

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=...
AWS_REGION=...
```

### Rules

- **Never** hardcode secrets in source code
- `.env` files listed in `.gitignore` — never committed
- `.env.example` contains placeholder keys with empty values for documentation
- ERP auth credentials stored as encrypted JSONB in `companies.erp_auth_config` — encrypted at rest
- API keys for external services rotated quarterly

---

## Transport & Storage Encryption

- **In Transit**: TLS 1.3 terminated at Nginx — all client-server communication over HTTPS
- **At Rest (DB)**: AWS RDS encryption enabled (AES-256)
- **At Rest (S3)**: Server-Side Encryption with S3-managed keys (SSE-S3)
- **At Rest (Redis)**: ElastiCache in-transit encryption enabled

---

## Rate Limiting & DDoS Protection

- Redis-backed rate limiter via Elysia middleware
- Default limits: 100 requests/minute per user, 1000 requests/minute per tenant
- Auth endpoints (login): 5 attempts per minute per IP
- S3 pre-signed URL generation: 30 requests/minute per user
- Exceeded limits return `429 Too Many Requests` with `Retry-After` header

---

## Audit Trail Architecture (Triple-Layer)

### Layer 1: Application Mutation Logs

- Table: `audit_mutation_logs`
- Captures: entity name, record ID, action type (INSERT/UPDATE/DELETE), before/after JSON snapshots
- Triggered by Elysia.js interceptor on all write operations
- Includes: `user_id`, `client_ip`, `company_id`

### Layer 2: Fraud Telemetry

- Table: `audit_fraud_telemetry`
- Captures: fraud type, claimed coordinates, accuracy, calculated speed, device info, raw payload
- Types: `MOCK_LOCATION`, `VELOCITY_ANOMALY`, `ACCURACY_EXCESS`, `CLOCK_DRIFT`
- Reviewed by Admin Cabang through dedicated fraud incident report

### Layer 3: ERP Sync Audit

- Table: `audit_erp_sync_logs`
- Captures: sync direction, endpoint URL, request/response payloads, HTTP status, latency, retry count
- Tracks success/failure of every outbound order push and inbound master sync

---

## Idempotency (ERP Integration)

- Every outbound ERP request includes a unique `idempotency_key` (UUID)
- Key stored in Redis with 24-hour TTL
- Duplicate key detection prevents creating duplicate Sales Quotations in ERP
- BullMQ retry logic respects idempotency — same key on retries ensures at-most-once delivery

---

## CORS & Origin Security

- Nginx CORS headers restrict origins to known domains:
  - `https://maction.kimiafarma.co.id`
  - `https://admin.maction.kimiafarma.co.id`
- S3 CORS policy allows PUT from PWA origin only
- No wildcard (`*`) origins in production
- Preflight cache: `Access-Control-Max-Age: 86400`
