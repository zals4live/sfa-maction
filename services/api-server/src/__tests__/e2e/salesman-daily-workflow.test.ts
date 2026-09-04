/**
 * End-to-end integration test — full SALESMAN daily workflow.
 *
 * Drives the real Elysia route handlers, middleware (tenantGuard, roleGuard,
 * attendanceLock, auditInterceptor) and module services for the complete
 * Salesman field day, chained in order:
 *
 *   1. Login (POST /auth/login)                 → JWT with company/soffice/role/lini
 *   2. GPS check-in (POST /attendance/check-in) → geofence via PostGIS
 *   3. Today's plan (GET /call-plans/today) + visit list (GET /visits)
 *   4. Visit-in (POST /visits/start)            → geofence via ST_DWithin
 *   5. In-visit CRUD: agenda / competitor / stock audit
 *   6. Order taking (POST /orders) + submit (POST /orders/:id/submit)
 *   7. Visit-out (POST /visits/:id/end)         → signature capture
 *   8. Check-out (POST /attendance/check-out)   → after time rule
 *   9. ERP sync: enqueue spy + real outbound worker → audit_erp_sync_logs
 *
 * External services (S3, Redis, ERP HTTP) are mocked; the database layer is a
 * table-keyed stateful in-memory mock so the RLS transaction helper, PostGIS
 * SQL calls, and every query chain resolve deterministically without a live DB.
 */

import { describe, it, expect, beforeAll, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'e2e-salesman-workflow-secret'
process.env['JWT_SECRET'] = TEST_SECRET

// --- Deterministic identifiers ---
const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440002'
const LINI_ID = '880e8400-e29b-41d4-a716-446655440003'
const CUSTOMER_ID = 'aa0e8400-e29b-41d4-a716-44665544000a'
const MATERIAL_ID = 'bb0e8400-e29b-41d4-a716-44665544000b'
const VISIT_ID = 'cc0e8400-e29b-41d4-a716-44665544000c'
const ORDER_ID = 'dd0e8400-e29b-41d4-a716-44665544000d'
const AGENDA_ID = 'ee0e8400-e29b-41d4-a716-44665544000e'
const STOCK_AUDIT_ID = 'ff0e8400-e29b-41d4-a716-44665544000f'
const COMPETITOR_AUDIT_ID = '11111111-e29b-41d4-a716-446655440011'
const IDEMPOTENCY_KEY = '22222222-e29b-41d4-a716-446655440022'

const SALESMAN_EMAIL = 'salesman@kimiafarma.test'
const SALESMAN_PASSWORD = 'Sup3rSecret!'

// A hash for SALESMAN_PASSWORD is generated in beforeAll and injected here.
let passwordHash = ''

// -----------------------------------------------------------------------------
// Table-keyed stateful mock database
// -----------------------------------------------------------------------------
//
// Both `db` (used directly by auth + attendanceLock) and the transaction handed
// to `withRLS` (used by every service) dispatch on the Drizzle table object
// identity passed to `.from(table)` / `.insert(table)` / `.update(table)` /
// `.delete(table)`. Terminal chain methods (`.limit`, `.offset`, `.orderBy`,
// `.returning`, and awaiting the node) resolve to deterministic rows.

import { appUsers, userLiniAssignments, absensi } from '../../db/schema/auth'
import { companies } from '../../db/schema/tenant'
import { masterCustomer } from '../../db/schema/customer'
import { masterMaterial, masterPrice } from '../../db/schema/material'
import { visitPlans, visits, visitAgendas, visitStockAudits, visitCompetitorAudits } from '../../db/schema/visit'
import { orders, orderItems, orderSequences } from '../../db/schema/order'
import { auditMutationLogs, auditErpSyncLogs, auditVisitLifecycle } from '../../db/schema/audit'

/** Mutable world state the mock DB reads from and writes to. */
interface WorldState {
  /** Whether an attendance check-in exists for the user today. */
  hasCheckInToday: boolean
  /** The current attendance row (null until check-in). */
  attendance: Record<string, unknown> | null
  /** Whether an open (un-ended) visit exists today. */
  hasOpenVisit: boolean
  /** The current order status, mutated by submit. */
  orderStatus: string
  /** Recorded ERP sync audit rows (auditErpSyncLogs inserts). */
  erpSyncAudits: Array<Record<string, unknown>>
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
    orderStatus: 'DRAFT',
    erpSyncAudits: [],
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
    email: SALESMAN_EMAIL,
    passwordHash,
    fullName: 'Budi Salesman',
    phoneNumber: '+628123456789',
    roleLabel: 'SALESMAN',
    avatarS3Key: null,
    currentSessionIp: null,
    isActive: true,
    isDeleted: false,
    createdAt: nowIso(),
  }
}

function attendanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '33333333-e29b-41d4-a716-446655440033',
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
    customerId: CUSTOMER_ID,
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

function orderRow(): Record<string, unknown> {
  return {
    id: ORDER_ID,
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    userId: USER_ID,
    customerId: CUSTOMER_ID,
    doctorCustomerId: null,
    visitId: VISIT_ID,
    orderNumber: 'ORD-20250101-0001',
    erpQuotationNumber: null,
    orderDate: todayDate(),
    subtotalAmount: '100000.00',
    totalDiscountAmount: '0',
    taxRate: '11.00',
    taxAmount: '11000.00',
    grandTotal: '111000.00',
    orderStatus: world.orderStatus,
    erpSyncTimestamp: null,
    pdfQuotationS3Key: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }
}

function orderItemRow(): Record<string, unknown> {
  return {
    id: '44444444-e29b-41d4-a716-446655440044',
    orderId: ORDER_ID,
    materialId: MATERIAL_ID,
    qty: 10,
    uom: 'PCS',
    unitPrice: '10000.00',
    discountPercentage: '0',
    discountAmount: '0',
    subtotal: '100000.00',
    promotionId: null,
    isFreeGoods: false,
    createdAt: nowIso(),
  }
}

// --- Query-node classification ----------------------------------------------

type Shape = 'projection' | 'row'

/**
 * Resolves the rows a query node should yield, dispatching on the target table
 * and (for a handful of projection selects) the projection key set. Insert and
 * update returning() results are handled separately in the builder.
 */
function rowsForSelect(table: unknown, projection?: Record<string, unknown>): Array<Record<string, unknown>> {
  const keys = projection ? Object.keys(projection) : []

  // --- auth.service + attendanceLock direct db reads ---
  if (table === appUsers) return [appUserRow()]
  if (table === userLiniAssignments) return [{ liniId: LINI_ID }]

  if (table === absensi) {
    // attendanceLock `{ id }` probe + attendance service duplicate/lookup probes.
    if (world.hasCheckInToday) return [world.attendance ?? attendanceRow()]
    return []
  }

  if (table === companies) {
    if (keys.includes('geofenceRadiusMeters')) return [{ geofenceRadiusMeters: 100 }]
    if (keys.includes('checkoutMinHour')) return [{ checkoutMinHour: 0 }] // allow checkout anytime in test
    if (keys.includes('defaultTaxRate')) return [{ defaultTaxRate: '11.00' }]
    // ERP config (used by real worker): endpoint + code + auth.
    if (keys.includes('endpointUrl') || keys.includes('erpEndpointUrl')) {
      return [{
        endpointUrl: 'https://erp.example.test/quotations',
        erpEndpointUrl: 'https://erp.example.test/quotations',
        companyCode: 'KF01',
        erpCompanyCode: 'KF01',
        authConfig: { access_token: 'secret' },
        erpAuthConfig: { access_token: 'secret' },
        defaultTaxRate: '11.00',
      }]
    }
    return [{ defaultTaxRate: '11.00', geofenceRadiusMeters: 100, checkoutMinHour: 0 }]
  }

  // --- geofence target (OUTLET customer) ---
  if (table === masterCustomer) {
    return [{ id: CUSTOMER_ID, customerType: 'OUTLET', latitude: -6.1751, longitude: 106.8272 }]
  }

  // --- order pricing ---
  if (table === masterMaterial) return [{ rules: { PCS: 1, STRIP: 10, BOX: 100 }, salesUom: 'PCS' }]
  if (table === masterPrice) return [{ priceRegular: '10000.00', per: 1 }]

  // --- call plan today ---
  if (table === visitPlans) {
    return [{
      id: '55555555-e29b-41d4-a716-446655440055',
      companyId: COMPANY_ID,
      userId: USER_ID,
      customerId: CUSTOMER_ID,
      outletId: null,
      planDate: todayDate(),
      planStatus: 'PENDING',
      notes: null,
      createdAt: nowIso(),
    }]
  }

  // --- visits ---
  if (table === visits) {
    // classifyVisitType probes visitPlans (not visits); assertNoOpenVisit probes
    // for an open visit id; fetchOwnedVisit / list return full rows.
    if (keys.length === 1 && keys.includes('id')) {
      return world.hasOpenVisit ? [{ id: VISIT_ID }] : []
    }
    if (keys.includes('total')) return [{ total: 1 }]
    return [visitRow()]
  }

  if (table === visitAgendas) return []
  if (table === visitStockAudits) return []
  if (table === visitCompetitorAudits) return []

  if (table === orders) {
    if (keys.includes('total')) return [{ total: 1 }]
    return [orderRow()]
  }
  if (table === orderItems) return [orderItemRow()]

  return []
}

/**
 * A chainable + awaitable (thenable) query node. The target table is bound into
 * the node's own closure at `.from()` (never a shared global), so interleaved
 * queries — e.g. the two parallel selects inside a `Promise.all` — never clobber
 * each other's table context.
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
          if (table === orders) return Promise.resolve([orderRow()])
          if (table === orderItems) {
            const arr = Array.isArray(vals) ? vals : [vals]
            return Promise.resolve(arr.map(() => orderItemRow()))
          }
          if (table === orderSequences) return Promise.resolve([{ lastSequence: 1 }])
          if (table === absensi) return Promise.resolve([attendanceRow()])
          if (table === visits) return Promise.resolve([visitRow()])
          if (table === visitAgendas) {
            return Promise.resolve([{ id: AGENDA_ID, visitId: VISIT_ID, topic: 'Product detailing', productDiscussedId: null, discussionSummary: null, photoS3Key: null, createdAt: nowIso() }])
          }
          if (table === visitStockAudits) {
            return Promise.resolve([{ id: STOCK_AUDIT_ID, visitId: VISIT_ID, materialId: MATERIAL_ID, physicalStockQty: 25, uom: 'PCS', estimatedDaysOfStock: 7, createdAt: nowIso() }])
          }
          if (table === visitCompetitorAudits) {
            return Promise.resolve([{ id: COMPETITOR_AUDIT_ID, visitId: VISIT_ID, competitorBrand: 'CompetitorX', competitorProduct: 'RivalMed', priceToPharmacy: '9500.00', consumerPrice: '12000.00', activePromoNotes: null, photoS3Key: null, createdAt: nowIso() }])
          }
          return Promise.resolve([{ id: '00000000-e29b-41d4-a716-446655440000' }])
        },
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ lastSequence: 1 }]),
        }),
        // Audit inserts have no returning() — they are awaited directly.
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          if (table === auditErpSyncLogs) world.erpSyncAudits.push(vals as Record<string, unknown>)
          else if (table === auditMutationLogs) world.mutationAudits.push(vals as Record<string, unknown>)
          else if (table === auditVisitLifecycle) world.lifecycleAudits.push(vals as Record<string, unknown>)
          return Promise.resolve(undefined).then(onF, onR)
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        // Apply state mutations eagerly at `.where()` time so both terminals
        // work: order.submitOrder awaits `.returning()`, while the ERP worker
        // and auth.service await `.where()` directly.
        const applyMutation = (): Array<Record<string, unknown>> => {
          if (table === orders) {
            if (vals['orderStatus']) world.orderStatus = vals['orderStatus'] as string
            return [{ ...orderRow(), orderStatus: world.orderStatus }]
          }
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
    // PostGIS raw SQL. Two consumers use tx.execute():
    //  - visit-in geofence check reads { within_geofence, distance_meters }
    //  - visit geom extraction reads { visit_in_lat/lng, visit_out_lat/lng }
    // A single merged row satisfies both without brittle SQL string matching.
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

// Redis: idempotency claim always won; connection is inert.
const redisSetCalls: Array<unknown[]> = []
mock.module('../../config/redis', () => ({
  redis: {
    set: (...args: unknown[]) => {
      redisSetCalls.push(args)
      return Promise.resolve('OK')
    },
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

// ERP sync worker: spy on enqueueOrderSync, keep the REAL worker (processErpOrderSyncJob)
// so step 9 exercises the genuine outbound path + audit recording.
const realErpWorker = await import('../../queues/erpSyncWorker')
const enqueueSpy = mock((_orderId: string, _companyId: string) => Promise.resolve(IDEMPOTENCY_KEY))
mock.module('../../queues/erpSyncWorker', () => ({
  ...realErpWorker,
  enqueueOrderSync: enqueueSpy,
}))

// Import routes + the real worker AFTER mocks are registered.
const { authRoutes } = await import('../../modules/auth/routes')
const { attendanceRoutes } = await import('../../modules/attendance/routes')
const { callPlanRoutes } = await import('../../modules/call-plan/routes')
const { visitRoutes } = await import('../../modules/visit/routes')
const { orderRoutes } = await import('../../modules/order/routes')
const { processErpOrderSyncJob } = await import('../../queues/erpSyncWorker')

// -----------------------------------------------------------------------------
// Request helpers
// -----------------------------------------------------------------------------

/** The composed API surface exercised by the workflow. */
const api = new Elysia()
  .use(authRoutes)
  .use(attendanceRoutes)
  .use(callPlanRoutes)
  .use(visitRoutes)
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

describe('E2E — full SALESMAN daily workflow', () => {
  beforeAll(async () => {
    world = freshWorld()
    passwordHash = await Bun.password.hash(SALESMAN_PASSWORD)
  })

  it('1. logs in and issues a JWT carrying SALESMAN role + lini_ids', async () => {
    const res = await api.handle(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: SALESMAN_EMAIL, password: SALESMAN_PASSWORD }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { token: string; user: { role_label: string; lini_ids: string[] } } }
    expect(body.data.token).toBeString()
    expect(body.data.user.role_label).toBe('SALESMAN')
    expect(body.data.user.lini_ids).toContain(LINI_ID)

    token = body.data.token

    // Sanity: the issued token verifies and carries the expected claims.
    const verifier = new Elysia().use(jwt({ name: 'jwt', secret: TEST_SECRET }))
    let claims: unknown = false
    await verifier
      .get('/v', async ({ jwt: j }) => {
        claims = await j.verify(token)
        return 'ok'
      })
      .handle(new Request('http://localhost/v'))
    expect(claims).not.toBe(false)
    expect((claims as Record<string, unknown>)['role_label']).toBe('SALESMAN')
  })

  it('2. checks in with a valid geofenced GPS position + selfie', async () => {
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

  it('4. starts a visit (visit-in) with ST_DWithin geofence validation', async () => {
    const res = await api.handle(
      authedRequest('POST', '/visits/start', {
        customer_id: CUSTOMER_ID,
        ...gps,
        ...antiSpoof,
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(VISIT_ID)
    expect(body.data?.['customer_id']).toBe(CUSTOMER_ID)

    // A lifecycle audit row (VISIT_IN) was recorded via the RLS tx.
    expect(world.lifecycleAudits.length).toBeGreaterThan(0)

    // Mark the visit open so a duplicate start would be rejected.
    world.hasOpenVisit = true
  })

  it('4b. rejects a second concurrent visit-in while one is open', async () => {
    const res = await api.handle(
      authedRequest('POST', '/visits/start', { customer_id: CUSTOMER_ID, ...gps, ...antiSpoof })
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as JsonEnvelope
    expect(body.error?.code).toBe('VISIT_ALREADY_OPEN')
  })

  it('5a. records a detailing agenda', async () => {
    const res = await api.handle(
      authedRequest('POST', `/visits/${VISIT_ID}/agendas`, {
        topic: 'Product detailing',
        discussion_summary: 'Presented new formulation to pharmacist',
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

  it('6a. creates a DRAFT order with price lookup + PPN tax', async () => {
    const res = await api.handle(
      authedRequest('POST', '/orders', {
        order_channel: 'ON_SITE',
        customer_id: CUSTOMER_ID,
        visit_id: VISIT_ID,
        items: [{ material_id: MATERIAL_ID, qty: 10, uom: 'PCS' }],
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['order_status']).toBe('DRAFT')
    expect(body.data?.['tax_rate']).toBe(11)
    expect(Array.isArray(body.data?.['items'])).toBe(true)
  })

  it('6b. submits the order (DRAFT \u2192 SUBMITTED) and enqueues ERP sync', async () => {
    const res = await api.handle(authedRequest('POST', `/orders/${ORDER_ID}/submit`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as JsonEnvelope
    expect(body.data?.['id']).toBe(ORDER_ID)
    expect(body.data?.['order_status']).toBe('SUBMITTED')

    // The outbound ERP sync job was enqueued with the order + tenant.
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy.mock.calls[0]?.[0]).toBe(ORDER_ID)
    expect(enqueueSpy.mock.calls[0]?.[1]).toBe(COMPANY_ID)
  })

  it('7. ends the visit (visit-out) with a captured signature', async () => {
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

  it('8. checks out after the time rule is satisfied', async () => {
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

  it('9. runs the outbound ERP sync worker \u2192 SYNCED_ERP + audit log with idempotency key', async () => {
    // Simulate the ERP gateway accepting the quotation.
    const realFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ quotation_number: 'QN-2025-0001' }), { status: 200 })
    ) as unknown as typeof fetch

    try {
      world.orderStatus = 'SUBMITTED'
      const job = {
        id: 'job-e2e-1',
        data: { orderId: ORDER_ID, companyId: COMPANY_ID, idempotencyKey: IDEMPOTENCY_KEY },
        attemptsMade: 0,
        opts: { attempts: 5 },
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await processErpOrderSyncJob(job as any)
    } finally {
      globalThis.fetch = realFetch
    }

    // Idempotency claim was attempted on Redis with the job's key.
    expect(redisSetCalls.length).toBeGreaterThan(0)

    // Order transitioned to SYNCED_ERP.
    expect(world.orderStatus).toBe('SYNCED_ERP')

    // A single OUTBOUND audit row was recorded for this order.
    expect(world.erpSyncAudits.length).toBe(1)
    const audit = world.erpSyncAudits[0]!
    expect(audit['syncDirection']).toBe('OUTBOUND')
    expect(audit['isSuccess']).toBe(true)
    expect(audit['relatedRecordId']).toBe(ORDER_ID)
  })
})
