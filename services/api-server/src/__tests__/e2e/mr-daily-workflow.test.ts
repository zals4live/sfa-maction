/**
 * End-to-end integration test — full MR (Medical Representative) daily workflow.
 *
 * Drives the real Elysia route handlers, middleware (tenantGuard, roleGuard,
 * attendanceLock, auditInterceptor) and module services for the complete MR
 * field day, chained in order:
 *
 *   1. Login (POST /auth/login)                 → JWT with MR role + lini_ids
 *   2. GPS check-in (POST /attendance/check-in) → geofence via PostGIS (MR category)
 *   3. Today's plan (GET /call-plans/today) + visit list (GET /visits)
 *   4. Visit-in on a DOCTOR (POST /visits/start) → geofence via ST_DWithin
 *   5. In-visit CRUD: agenda (detailing) / competitor / stock audit  (shared)
 *   6. Read-only price + stock lookup (GET /materials/:id/price, /:id/stock)
 *   7. NO orders — MR is barred from the order-taking surface:
 *        POST /orders          → 403 FORBIDDEN
 *        POST /orders/:id/submit → 403 FORBIDDEN
 *        GET  /orders (read)   → 403 FORBIDDEN (MR excluded from orders RLS)
 *   8. Visit-out (POST /visits/:id/end)         → signature capture
 *   9. Check-out (POST /attendance/check-out)   → after time rule
 *
 * MR-specific invariants asserted:
 *   - JWT carries role_label = 'MR'
 *   - MR performs full detailing on a DOCTOR customer
 *   - MR reads price/stock (lini-scoped by RLS) but never creates/submits orders
 *   - Order create/submit/read all return structured 403 FORBIDDEN for MR
 *
 * External services (S3, Redis, ERP HTTP) are mocked; the database layer is a
 * table-keyed stateful in-memory mock so the RLS transaction helper, PostGIS
 * SQL calls, and every query chain resolve deterministically without a live DB.
 */

import { describe, it, expect, beforeAll, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'e2e-mr-workflow-secret'
process.env['JWT_SECRET'] = TEST_SECRET

// --- Deterministic identifiers ---
const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440101'
const USER_ID = '550e8400-e29b-41d4-a716-446655440100'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440102'
const LINI_ID = '880e8400-e29b-41d4-a716-446655440103'
const DOCTOR_ID = 'aa0e8400-e29b-41d4-a716-44665544010a'
const MATERIAL_ID = 'bb0e8400-e29b-41d4-a716-44665544010b'
const VISIT_ID = 'cc0e8400-e29b-41d4-a716-44665544010c'
const AGENDA_ID = 'ee0e8400-e29b-41d4-a716-44665544010e'
const STOCK_AUDIT_ID = 'ff0e8400-e29b-41d4-a716-44665544010f'
const COMPETITOR_AUDIT_ID = '11111111-e29b-41d4-a716-446655440111'
const PRICE_ID = '22222222-e29b-41d4-a716-446655440122'
const STOCK_ID = '33333333-e29b-41d4-a716-446655440133'

const MR_EMAIL = 'mr@kimiafarma.test'
const MR_PASSWORD = 'D3tailing!'

// A hash for MR_PASSWORD is generated in beforeAll and injected here.
let passwordHash = ''

// -----------------------------------------------------------------------------
// Table-keyed stateful mock database
// -----------------------------------------------------------------------------
//
// Both `db` (used directly by auth + attendanceLock) and the transaction handed
// to `withRLS` (used by every service) dispatch on the Drizzle table object
// identity passed to `.from(table)` / `.insert(table)` / `.update(table)`.

import { appUsers, userLiniAssignments, absensi } from '../../db/schema/auth'
import { companies } from '../../db/schema/tenant'
import { masterCustomer } from '../../db/schema/customer'
import { masterMaterial, masterPrice, stockInventoryAtp } from '../../db/schema/material'
import { visitPlans, visits, visitAgendas, visitStockAudits, visitCompetitorAudits } from '../../db/schema/visit'
import { auditMutationLogs, auditVisitLifecycle } from '../../db/schema/audit'

/** Mutable world state the mock DB reads from and writes to. */
interface WorldState {
  /** Whether an attendance check-in exists for the user today. */
  hasCheckInToday: boolean
  /** The current attendance row (null until check-in). */
  attendance: Record<string, unknown> | null
  /** Whether an open (un-ended) visit exists today. */
  hasOpenVisit: boolean
  /** Recorded application mutation audit rows. */
  mutationAudits: Array<Record<string, unknown>>
  /** Recorded visit lifecycle audit rows. */
  lifecycleAudits: Array<Record<string, unknown>>
}

function freshWorld(): WorldState {
  return {
    hasCheckInToday: false,
    attendance: null,
    hasOpenVisit: false,
    mutationAudits: [],
    lifecycleAudits: [],
  }
}

let world: WorldState = freshWorld()

const nowIso = (): string => new Date().toISOString()
const todayDate = (): string => new Date().toISOString().split('T')[0]!

// --- Row factories -----------------------------------------------------------

function appUserRow(): Record<string, unknown> {
  return {
    id: USER_ID,
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    email: MR_EMAIL,
    passwordHash,
    fullName: 'Sari Medical Rep',
    phoneNumber: '+628123456700',
    roleLabel: 'MR',
    avatarS3Key: null,
    currentSessionIp: null,
    isActive: true,
    isDeleted: false,
    createdAt: nowIso(),
  }
}

function attendanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '44444444-e29b-41d4-a716-446655440044',
    companyId: COMPANY_ID,
    userId: USER_ID,
    attendanceDate: todayDate(),
    attendanceType: 'CUSTOMER',
    checkInTime: nowIso(),
    checkInGeom: { x: 106.8272, y: -6.1751 },
    checkInPhotoS3Key: `${COMPANY_ID}/attendance/2025/selfie.jpg`,
    checkInDistanceMeters: 12,
    checkOutTime: null,
    checkOutGeom: null,
    checkOutPhotoS3Key: null,
    notes: null,
    createdAt: nowIso(),
    ...overrides,
  }
}

function visitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VISIT_ID,
    companyId: COMPANY_ID,
    userId: USER_ID,
    customerId: DOCTOR_ID,
    outletId: null,
    picId: null,
    visitType: 'PLANNED',
    visitDate: todayDate(),
    visitInAt: nowIso(),
    visitInGeom: 'POINT(106.8272 -6.1751)',
    visitInDistanceMeters: 8,
    visitOutAt: null,
    visitOutGeom: null,
    signatureS3Key: null,
    notes: null,
    syncStatus: 'SYNCED',
    createdAt: nowIso(),
    ...overrides,
  }
}

function priceRow(): Record<string, unknown> {
  return {
    id: PRICE_ID,
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    materialId: MATERIAL_ID,
    varianId: null,
    priceRegular: '10000.00',
    priceHja: '12000.00',
    priceHet: '13000.00',
    per: 1,
    salesUom: 'PCS',
    validFrom: '2020-01-01',
    validTo: '2999-12-31',
    createdAt: nowIso(),
  }
}

function stockRow(): Record<string, unknown> {
  return {
    id: STOCK_ID,
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    materialId: MATERIAL_ID,
    varianId: null,
    batch: 'BATCH-2025-01',
    sled: '2026-06-30',
    qtyAvailable: '250.00',
    qtyAllocated: '10.00',
    stockValue: '2500000.00',
    uom: 'PCS',
    lastSyncedAt: nowIso(),
  }
}

// --- Query-node classification ----------------------------------------------

/**
 * Resolves the rows a query node should yield, dispatching on the target table
 * and (for a handful of projection selects) the projection key set.
 */
function rowsForSelect(table: unknown, projection?: Record<string, unknown>): Array<Record<string, unknown>> {
  const keys = projection ? Object.keys(projection) : []

  // --- auth.service + attendanceLock direct db reads ---
  if (table === appUsers) return [appUserRow()]
  if (table === userLiniAssignments) return [{ liniId: LINI_ID }]

  if (table === absensi) {
    if (world.hasCheckInToday) return [world.attendance ?? attendanceRow()]
    return []
  }

  if (table === companies) {
    if (keys.includes('geofenceRadiusMeters')) return [{ geofenceRadiusMeters: 100 }]
    if (keys.includes('checkoutMinHour')) return [{ checkoutMinHour: 0 }] // allow checkout anytime in test
    return [{ defaultTaxRate: '11.00', geofenceRadiusMeters: 100, checkoutMinHour: 0 }]
  }

  // --- geofence target: MR visits a DOCTOR customer ---
  if (table === masterCustomer) {
    return [{ id: DOCTOR_ID, customerType: 'DOCTOR', latitude: -6.1751, longitude: 106.8272 }]
  }

  // --- material existence + price/stock lookups ---
  if (table === masterMaterial) {
    // assertMaterialExists probes { id }; getMaterialById returns full row shape.
    return [{
      id: MATERIAL_ID,
      companyId: COMPANY_ID,
      erpMaterialCode: 'MAT-001',
      name: 'Paracetamol 500mg',
      baseUom: 'PCS',
      salesUom: 'PCS',
      nie: 'DKL1234567890A1',
      validNie: '2030-01-01',
      liniId: LINI_ID,
      manufacture: 'Kimia Farma',
      principal: 'KF',
      uomConversionRules: { PCS: 1, STRIP: 10, BOX: 100 },
      isNarcoticPsychotropic: false,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }]
  }
  if (table === masterPrice) return [priceRow()]
  if (table === stockInventoryAtp) return [stockRow()]

  // --- call plan today ---
  if (table === visitPlans) {
    return [{
      id: '55555555-e29b-41d4-a716-446655440155',
      companyId: COMPANY_ID,
      userId: USER_ID,
      customerId: DOCTOR_ID,
      outletId: null,
      planDate: todayDate(),
      planStatus: 'PENDING',
      notes: null,
      createdAt: nowIso(),
    }]
  }

  // --- visits ---
  if (table === visits) {
    if (keys.length === 1 && keys.includes('id')) {
      return world.hasOpenVisit ? [{ id: VISIT_ID }] : []
    }
    if (keys.includes('total')) return [{ total: 1 }]
    return [visitRow()]
  }

  if (table === visitAgendas) return []
  if (table === visitStockAudits) return []
  if (table === visitCompetitorAudits) return []

  return []
}

/**
 * A chainable + awaitable (thenable) query node. The target table is bound into
 * the node's own closure at `.from()` so interleaved queries never clobber each
 * other's table context.
 */
function selectNode(projection?: Record<string, unknown>): Record<string, unknown> {
  let boundTable: unknown = null
  const resolve = (): Promise<Array<Record<string, unknown>>> =>
    Promise.resolve(rowsForSelect(boundTable, projection))
  const node: Record<string, unknown> = {
    from: (table: unknown) => {
      boundTable = table
      return node
    },
    innerJoin: () => node,
    leftJoin: () => node,
    where: () => node,
    orderBy: () => node,
    groupBy: () => node,
    limit: () => node,
    offset: () => node,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => resolve().then(onF, onR),
  }
  return node
}

/** Builds the fake tx / db object shared by direct reads and withRLS callbacks. */
function buildMockTx(): unknown {
  return {
    select: (projection?: Record<string, unknown>) => selectNode(projection),
    insert: (table: unknown) => ({
      values: (vals: unknown) => ({
        returning: () => {
          if (table === absensi) return Promise.resolve([attendanceRow()])
          if (table === visits) return Promise.resolve([visitRow()])
          if (table === visitAgendas) {
            return Promise.resolve([{ id: AGENDA_ID, visitId: VISIT_ID, topic: 'Medical detailing', productDiscussedId: null, discussionSummary: null, photoS3Key: null, createdAt: nowIso() }])
          }
          if (table === visitStockAudits) {
            return Promise.resolve([{ id: STOCK_AUDIT_ID, visitId: VISIT_ID, materialId: MATERIAL_ID, physicalStockQty: 25, uom: 'PCS', estimatedDaysOfStock: 7, createdAt: nowIso() }])
          }
          if (table === visitCompetitorAudits) {
            return Promise.resolve([{ id: COMPETITOR_AUDIT_ID, visitId: VISIT_ID, competitorBrand: 'CompetitorX', competitorProduct: 'RivalMed', priceToPharmacy: '9500.00', consumerPrice: '12000.00', activePromoNotes: null, photoS3Key: null, createdAt: nowIso() }])
          }
          return Promise.resolve([{ id: '00000000-e29b-41d4-a716-446655440000' }])
        },
        // Audit inserts have no returning() — they are awaited directly.
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          if (table === auditMutationLogs) world.mutationAudits.push(vals as Record<string, unknown>)
          else if (table === auditVisitLifecycle) world.lifecycleAudits.push(vals as Record<string, unknown>)
          return Promise.resolve(undefined).then(onF, onR)
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        const applyMutation = (): Array<Record<string, unknown>> => {
          if (table === absensi) return [attendanceRow({ checkOutTime: nowIso() })]
          if (table === visits) {
            return [visitRow({ visitOutAt: nowIso(), signatureS3Key: (vals['signatureS3Key'] as string) ?? 'sig.png' })]
          }
          return [{ id: '00000000-e29b-41d4-a716-446655440000' }]
        }
        return {
          where: () => {
            const rows = applyMutation()
            return {
              returning: () => Promise.resolve(rows),
              then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
                Promise.resolve(undefined).then(onF, onR),
            }
          },
        }
      },
    }),
    delete: (_table: unknown) => ({
      where: () => ({
        returning: () => Promise.resolve([{ id: '00000000-e29b-41d4-a716-446655440000' }]),
      }),
    }),
    // PostGIS raw SQL. Consumers: visit-in geofence check + geom extraction.
    execute: () =>
      Promise.resolve([
        {
          within_geofence: true,
          distance_meters: 8,
          visit_in_lat: -6.1751,
          visit_in_lng: 106.8272,
          visit_out_lat: null,
          visit_out_lng: null,
        },
      ]),
  }
}

// -----------------------------------------------------------------------------
// Module mocks
// -----------------------------------------------------------------------------

const realDb = await import('../../db')
mock.module('../../db', () => ({
  ...realDb,
  db: buildMockTx(),
  withRLS: async (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(buildMockTx()),
}))

// Session: stateful in-memory store so login's minted session_id flows through to
// tenantGuard. tenantGuard now binds each token to its login's session_id (single
// active session, FR-AUTH-02), so getSession must echo exactly what login stored.
let e2eSession: Record<string, unknown> | null = null
mock.module('../../config/session', () => ({
  getSession: async () => e2eSession,
  createSession: async (
    _c: string,
    _u: string,
    data: Record<string, unknown>
  ) => {
    e2eSession = data
  },
  deleteSession: async () => {
    e2eSession = null
  },
  buildSessionKey: (c: string, u: string) => `session:${c}:${u}`,
  SESSION_TTL_FIELD: 86400,
  SESSION_TTL_ADMIN: 28800,
}))

// Redis: inert.
mock.module('../../config/redis', () => ({
  redis: {
    set: () => Promise.resolve('OK'),
  },
  createRedisConnection: () => ({}),
  REDIS_URL: 'redis://localhost:6379',
}))

// S3: pre-signed URLs + uploads are inert.
mock.module('../../config/s3', () => ({
  generateUploadUrl: async (opts: { key: string }) => `https://s3.example.test/${opts.key}?put=1`,
  generateDownloadUrl: async (opts: { key: string }) => `https://s3.example.test/${opts.key}?get=1`,
  uploadObject: async () => {},
  buildS3Key: (opts: { companyId: string; category: string; fileId: string; extension: string }) =>
    `${opts.companyId}/${opts.category}/2025/${opts.fileId}.${opts.extension}`,
}))

// Import routes AFTER mocks are registered.
const { authRoutes } = await import('../../modules/auth/routes')
const { attendanceRoutes } = await import('../../modules/attendance/routes')
const { callPlanRoutes } = await import('../../modules/call-plan/routes')
const { visitRoutes } = await import('../../modules/visit/routes')
const { materialRoutes } = await import('../../modules/material/routes')
const { orderRoutes } = await import('../../modules/order/routes')

// -----------------------------------------------------------------------------
// Request helpers
// -----------------------------------------------------------------------------

/** The composed API surface exercised by the workflow. */
const api = new Elysia()
  .use(authRoutes)
  .use(attendanceRoutes)
  .use(callPlanRoutes)
  .use(visitRoutes)
  .use(materialRoutes)
  .use(orderRoutes)

let token = ''

function authedRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  }
  if (body) init.body = JSON.stringify(body)
  return new Request(`http://localhost${path}`, init)
}

const antiSpoof = { monotonic_delta_ms: 1200, client_timestamp: nowIso() }
const gps = { latitude: -6.1751, longitude: 106.8272, accuracy: 8 }

interface JsonEnvelope {
  data?: Record<string, unknown>
  meta?: Record<string, unknown>
  error?: { code: string; message: string }
}

// -----------------------------------------------------------------------------
// Workflow
// -----------------------------------------------------------------------------

describe('E2E — full MR daily workflow', () => {
  beforeAll(async () => {
    world = freshWorld()
    passwordHash = await Bun.password.hash(MR_PASSWORD)
  })

  it('1. logs in and issues a JWT carrying MR role + lini_ids', async () => {
    const res = await api.handle(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: MR_EMAIL, password: MR_PASSWORD }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { token: string; user: { role_label: string; lini_ids: string[] } } }
    expect(body.data.token).toBeString()
    expect(body.data.user.role_label).toBe('MR')
    expect(body.data.user.lini_ids).toContain(LINI_ID)

    token = body.data.token

    // Sanity: the issued token verifies and carries the MR claim.
    const verifier = new Elysia().use(jwt({ name: 'jwt', secret: TEST_SECRET }))
    let claims: unknown = false
    await verifier
      .get('/v', async ({ jwt: j }) => {
        claims = await j.verify(token)
        return 'ok'
      })
      .handle(new Request('http://localhost/v'))
    expect(claims).not.toBe(false)
    expect((claims as Record<string, unknown>)['role_label']).toBe('MR')
  })

  it('2. checks in with a valid geofenced GPS position + selfie (MR category)', async () => {
    const res = await api.handle(
      authedRequest('POST', '/attendance/check-in', {
        attendance_type: 'CUSTOMER',
        photo_s3_key: `${COMPANY_ID}/attendance/2025/selfie.jpg`,
        ...gps,
        ...antiSpoof,
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['user_id']).toBe(USER_ID)
    expect(body.data?.['check_in_photo_s3_key']).toBeString()

    // Unlock downstream visit features by marking today's attendance present.
    world.hasCheckInToday = true
    world.attendance = attendanceRow()
  })

  it('3a. fetches today\u2019s call plan', async () => {
    const res = await api.handle(authedRequest('GET', '/call-plans/today'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(Array.isArray(body.data)).toBe(true)
    expect((body.data as unknown as unknown[]).length).toBeGreaterThan(0)
  })

  it('3b. lists visits (empty at start of day)', async () => {
    const res = await api.handle(authedRequest('GET', '/visits'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(body.meta).toBeDefined()
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('4. starts a visit on a DOCTOR (visit-in) with ST_DWithin geofence validation', async () => {
    const res = await api.handle(
      authedRequest('POST', '/visits/start', {
        customer_id: DOCTOR_ID,
        ...gps,
        ...antiSpoof,
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(VISIT_ID)
    expect(body.data?.['customer_id']).toBe(DOCTOR_ID)

    // A lifecycle audit row (VISIT_IN) was recorded via the RLS tx.
    expect(world.lifecycleAudits.length).toBeGreaterThan(0)

    world.hasOpenVisit = true
  })

  it('5a. records a medical detailing agenda', async () => {
    const res = await api.handle(
      authedRequest('POST', `/visits/${VISIT_ID}/agendas`, {
        topic: 'Medical detailing',
        discussion_summary: 'Presented clinical data to the doctor',
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(AGENDA_ID)
  })

  it('5b. records a competitor audit', async () => {
    const res = await api.handle(
      authedRequest('POST', `/visits/${VISIT_ID}/competitor-audits`, {
        competitor_brand: 'CompetitorX',
        competitor_product: 'RivalMed',
        price_to_pharmacy: 9500,
        consumer_price: 12000,
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(COMPETITOR_AUDIT_ID)
  })

  it('5c. records a stock audit', async () => {
    const res = await api.handle(
      authedRequest('POST', `/visits/${VISIT_ID}/stock-audits`, {
        material_id: MATERIAL_ID,
        physical_stock_qty: 25,
        uom: 'PCS',
        estimated_days_of_stock: 7,
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(STOCK_AUDIT_ID)
  })

  it('6a. looks up a material price (read-only, MR-permitted)', async () => {
    const res = await api.handle(authedRequest('GET', `/materials/${MATERIAL_ID}/price`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['material_id']).toBe(MATERIAL_ID)
    expect(body.data?.['price_regular']).toBe(10000)
  })

  it('6b. looks up material ATP stock (read-only, MR-permitted)', async () => {
    const res = await api.handle(authedRequest('GET', `/materials/${MATERIAL_ID}/stock`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(Array.isArray(body.data)).toBe(true)
    const rows = body.data as unknown as Array<Record<string, unknown>>
    expect(rows[0]?.['material_id']).toBe(MATERIAL_ID)
    expect(rows[0]?.['qty_available']).toBe(250)
  })

  it('7a. is FORBIDDEN from creating an order (POST /orders \u2192 403)', async () => {
    const res = await api.handle(
      authedRequest('POST', '/orders', {
        order_channel: 'ON_SITE',
        customer_id: DOCTOR_ID,
        visit_id: VISIT_ID,
        items: [{ material_id: MATERIAL_ID, qty: 10, uom: 'PCS' }],
      })
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as JsonEnvelope
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  it('7b. is FORBIDDEN from submitting an order (POST /orders/:id/submit \u2192 403)', async () => {
    const res = await api.handle(authedRequest('POST', `/orders/${VISIT_ID}/submit`))
    expect(res.status).toBe(403)
    const body = (await res.json()) as JsonEnvelope
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  it('7c. is FORBIDDEN from reading orders (GET /orders \u2192 403, excluded from orders RLS)', async () => {
    const res = await api.handle(authedRequest('GET', '/orders'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as JsonEnvelope
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  it('8. ends the visit (visit-out) with a captured signature', async () => {
    const res = await api.handle(
      authedRequest('POST', `/visits/${VISIT_ID}/end`, {
        ...gps,
        signature_s3_key: `${COMPANY_ID}/visits/signatures/2025/sig.png`,
        ...antiSpoof,
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(VISIT_ID)
    expect(body.data?.['visit_out_at']).toBeString()
    expect(body.data?.['signature_s3_key']).toBeString()

    world.hasOpenVisit = false
  })

  it('9. checks out after the time rule is satisfied', async () => {
    const res = await api.handle(
      authedRequest('POST', '/attendance/check-out', {
        ...gps,
        photo_s3_key: `${COMPANY_ID}/attendance/2025/checkout.jpg`,
        ...antiSpoof,
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['check_out_time']).toBeString()
  })
})
