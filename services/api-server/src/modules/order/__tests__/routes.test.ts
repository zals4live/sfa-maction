import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'test-secret-key-for-unit-tests'

// Must set env before importing modules that read JWT_SECRET
process.env['JWT_SECRET'] = TEST_SECRET

const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440002'
const ORDER_ID = '990e8400-e29b-41d4-a716-446655440009'
const CUSTOMER_ID = 'aa0e8400-e29b-41d4-a716-44665544000a'
const MATERIAL_ID = 'bb0e8400-e29b-41d4-a716-44665544000b'
const SESSION_ID = 'dd0e8400-e29b-41d4-a716-44665544000d'

// Mock Redis session lookup to always return a valid session. session_id must
// match the token's claim — tenantGuard binds each token to its originating
// login's session (single-session enforcement, FR-AUTH-02).
mock.module('../../../config/session', () => ({
  getSession: async () => ({
    session_id: SESSION_ID,
    company_id: COMPANY_ID,
    user_id: USER_ID,
    soffice_id: SOFFICE_ID,
    role_label: 'SALESMAN',
    ip: '127.0.0.1',
    created_at: new Date().toISOString(),
  }),
  createSession: async () => {},
  deleteSession: async () => {},
  buildSessionKey: (companyId: string, userId: string) => `session:${companyId}:${userId}`,
  SESSION_TTL_FIELD: 86400,
  SESSION_TTL_ADMIN: 28800,
}))

// --- Configurable mock transaction state ---
interface MockTxState {
  pdfS3Key: string | null
  orderStatus: string
}

let txState: MockTxState

function resetTxState(): void {
  txState = { pdfS3Key: 'company/orders/quotations/2025/order.pdf', orderStatus: 'DRAFT' }
}

resetTxState()

function orderRow(): Record<string, unknown> {
  return {
    id: ORDER_ID,
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    userId: USER_ID,
    customerId: CUSTOMER_ID,
    doctorCustomerId: null,
    visitId: null,
    orderNumber: 'ORD-20250101-0001',
    erpQuotationNumber: null,
    orderDate: '2025-01-01',
    subtotalAmount: '10000.00',
    totalDiscountAmount: '0',
    taxRate: '11.00',
    taxAmount: '1100.00',
    grandTotal: '11100.00',
    orderStatus: txState.orderStatus,
    erpSyncTimestamp: null,
    pdfQuotationS3Key: txState.pdfS3Key,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }
}

function itemRow(): Record<string, unknown> {
  return {
    id: 'cc0e8400-e29b-41d4-a716-44665544000c',
    orderId: ORDER_ID,
    materialId: MATERIAL_ID,
    qty: 1,
    uom: 'PCS',
    unitPrice: '10000.00',
    discountPercentage: '0',
    discountAmount: '0',
    subtotal: '10000.00',
    promotionId: null,
    isFreeGoods: false,
    createdAt: '2025-01-01T00:00:00.000Z',
  }
}

/**
 * A query builder node that is both chainable and awaitable (thenable). Every
 * chain method returns the same node; awaiting it (or calling a terminal like
 * `.limit()`/`.offset()`) resolves to the configured rows. `shape` selects which
 * rows the node yields, classified from the `.select()` projection keys.
 */
type Shape = 'material' | 'price' | 'company' | 'count' | 'order' | 'items' | 'quotationLines' | 'customer' | 'branding'

function rowsFor(shape: Shape): Array<Record<string, unknown>> {
  switch (shape) {
    case 'material':
      return [{ rules: { PCS: 1, STRIP: 10, BOX: 100 } }]
    case 'price':
      return [{ priceRegular: '10000.00', per: 1 }]
    case 'company':
      return [{ defaultTaxRate: '11.00' }]
    case 'count':
      return [{ total: 1 }]
    case 'items':
      return [itemRow()]
    case 'quotationLines':
      return [
        {
          materialName: 'Paracetamol 500mg',
          qty: 1,
          uom: 'PCS',
          unitPrice: '10000.00',
          discountPercentage: '0',
          subtotal: '10000.00',
          isFreeGoods: false,
        },
      ]
    case 'customer':
      return [{ name: 'Apotek Sehat' }]
    case 'branding':
      return [{ name: 'Kimia Farma Trading', defaultTaxRate: '11.00' }]
    default:
      return [orderRow()]
  }
}

function makeNode(shape: Shape): Record<string, unknown> {
  const resolve = () => Promise.resolve(rowsFor(shape))
  const node: Record<string, unknown> = {
    from: () => node,
    innerJoin: () => node,
    where: () => node,
    // For the unprojected `order` select, a trailing `.orderBy()` awaited directly
    // is fetchOrderItems (→ item rows); a `.orderBy().limit().offset()` chain is
    // listOrders (→ order rows). The returned node yields items when awaited but
    // order rows when `.limit()`/`.offset()` follow.
    orderBy: () => (shape === 'order' ? makeOrderByNode() : node),
    limit: () => resolve(),
    offset: () => resolve(),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      resolve().then(onFulfilled, onRejected),
  }
  return node
}

/** Node returned by `.orderBy()` on the `order` shape (see makeNode comment). */
function makeOrderByNode(): Record<string, unknown> {
  const node: Record<string, unknown> = {
    limit: () => makeNode('order'),
    offset: () => Promise.resolve(rowsFor('order')),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor('items')).then(onFulfilled, onRejected),
  }
  return node
}

function classify(projection?: Record<string, unknown>): Shape {
  const keys = projection ? Object.keys(projection) : []
  if (keys.includes('rules')) return 'material'
  if (keys.includes('priceRegular')) return 'price'
  if (keys.includes('materialName')) return 'quotationLines'
  if (keys.includes('name')) return keys.includes('defaultTaxRate') ? 'branding' : 'customer'
  if (keys.includes('defaultTaxRate')) return 'company'
  if (keys.includes('total')) return 'count'
  return 'order'
}

/**
 * Builds a mock Drizzle transaction covering the query chains used by the order
 * service: select (limit / orderBy / orderBy+limit+offset), count selects,
 * insert...returning, and update...returning. Terminal methods resolve
 * deterministic rows so the real route handlers execute end-to-end without a DB.
 */
function buildMockTx(): unknown {
  return {
    select: (projection?: Record<string, unknown>) => makeNode(classify(projection)),
    insert: () => ({
      values: (vals: unknown) => ({
        returning: () =>
          Array.isArray(vals) ? Promise.resolve([itemRow()]) : Promise.resolve([orderRow()]),
        // order_sequences upsert: INSERT ... ON CONFLICT DO UPDATE ... RETURNING
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ lastSequence: 1 }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([orderRow()]) }),
      }),
    }),
  }
}

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(buildMockTx()),
}))

mock.module('../../../config/s3', () => ({
  generateDownloadUrl: (opts: { key: string; expiresIn?: number }) =>
    Promise.resolve(`https://s3.example.test/${opts.key}?signed=1`),
  uploadObject: async () => {},
  buildS3Key: (opts: { companyId: string; category: string; fileId: string; extension: string }) =>
    `${opts.companyId}/${opts.category}/2025/${opts.fileId}.${opts.extension}`,
}))

const { orderRoutes } = await import('../routes')

const baseClaims = {
  user_id: USER_ID,
  company_id: COMPANY_ID,
  soffice_id: SOFFICE_ID,
  lini_ids: ['880e8400-e29b-41d4-a716-446655440003'],
  session_id: SESSION_ID,
}

/** Helper to sign a JWT token with the test secret */
async function signToken(
  payload: Record<string, string | string[] | number | boolean>
): Promise<string> {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: TEST_SECRET }))
  let token = ''
  const app = signer.get('/sign', async ({ jwt: j }) => {
    token = await j.sign(payload)
    return token
  })
  await app.handle(new Request('http://localhost/sign'))
  return token
}

function makeRequest(method: string, path: string, token: string, body?: unknown): Request {
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

interface ErrorBody {
  error: { code: string; message: string }
}

interface OrderData {
  id: string
  order_status: string
  items: unknown[]
}

interface DetailBody {
  data: OrderData
}

interface ListBody {
  data: unknown[]
  meta: { page: number; limit: number; total: number }
}

interface PdfBody {
  data: { pdf_url: string; expires_in: number }
}

const validOrderBody = {
  order_channel: 'ON_SITE',
  customer_id: CUSTOMER_ID,
  items: [{ material_id: MATERIAL_ID, qty: 1, uom: 'PCS' }],
}

describe('Order routes — RBAC & handlers', () => {
  const app = orderRoutes

  beforeEach(() => {
    resetTxState()
  })

  describe('MR role receives 403 Forbidden', () => {
    let mrToken: string

    beforeAll(async () => {
      mrToken = await signToken({ ...baseClaims, role_label: 'MR' })
    })

    it('returns 403 on POST /orders for MR', async () => {
      const res = await app.handle(makeRequest('POST', '/orders', mrToken, validOrderBody))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.message).toContain('SALESMAN')
    })

    it('returns 403 on GET /orders for MR', async () => {
      const res = await app.handle(makeRequest('GET', '/orders', mrToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on GET /orders/:id for MR', async () => {
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}`, mrToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /orders/:id/submit for MR', async () => {
      const res = await app.handle(makeRequest('POST', `/orders/${ORDER_ID}/submit`, mrToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on GET /orders/:id/pdf for MR', async () => {
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}/pdf`, mrToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /orders/:id/pdf for MR', async () => {
      const res = await app.handle(makeRequest('POST', `/orders/${ORDER_ID}/pdf`, mrToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })
  })

  describe('Admin roles can read but not write orders', () => {
    let adminToken: string

    beforeAll(async () => {
      adminToken = await signToken({ ...baseClaims, role_label: 'ADMIN_CABANG' })
    })

    it('allows GET /orders for an admin role', async () => {
      const res = await app.handle(makeRequest('GET', '/orders', adminToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as ListBody
      expect(body.data).toBeDefined()
      expect(body.meta).toBeDefined()
    })

    it('allows GET /orders/:id for an admin role', async () => {
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}`, adminToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as DetailBody
      expect(body.data.id).toBe(ORDER_ID)
    })

    it('returns 403 on POST /orders for an admin role', async () => {
      const res = await app.handle(makeRequest('POST', '/orders', adminToken, validOrderBody))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /orders/:id/submit for an admin role', async () => {
      const res = await app.handle(makeRequest('POST', `/orders/${ORDER_ID}/submit`, adminToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on GET /orders/:id/pdf for an admin role', async () => {
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}/pdf`, adminToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /orders/:id/pdf for an admin role', async () => {
      const res = await app.handle(makeRequest('POST', `/orders/${ORDER_ID}/pdf`, adminToken))
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })
  })

  describe('SALESMAN role is allowed', () => {
    let salesmanToken: string

    beforeAll(async () => {
      salesmanToken = await signToken({ ...baseClaims, role_label: 'SALESMAN' })
    })

    it('returns 201 with a DRAFT order on POST /orders', async () => {
      const res = await app.handle(makeRequest('POST', '/orders', salesmanToken, validOrderBody))
      expect(res.status).toBe(201)
      const body = (await res.json()) as DetailBody
      expect(body.data).toBeDefined()
      expect(body.data.order_status).toBe('DRAFT')
      expect(Array.isArray(body.data.items)).toBe(true)
    })

    it('returns a paginated list on GET /orders', async () => {
      const res = await app.handle(makeRequest('GET', '/orders', salesmanToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as ListBody
      expect(body.data).toBeDefined()
      expect(body.meta).toBeDefined()
      expect(body.meta.page).toBe(1)
    })

    it('returns the order detail on GET /orders/:id', async () => {
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}`, salesmanToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as DetailBody
      expect(body.data.id).toBe(ORDER_ID)
      expect(Array.isArray(body.data.items)).toBe(true)
    })

    it('transitions DRAFT → SUBMITTED on POST /orders/:id/submit', async () => {
      const res = await app.handle(makeRequest('POST', `/orders/${ORDER_ID}/submit`, salesmanToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as DetailBody
      expect(body.data.id).toBe(ORDER_ID)
    })

    it('returns a pre-signed PDF URL on GET /orders/:id/pdf', async () => {
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}/pdf`, salesmanToken))
      expect(res.status).toBe(200)
      const body = (await res.json()) as PdfBody
      expect(body.data.pdf_url).toBeDefined()
      expect(body.data.expires_in).toBe(3600)
    })

    it('returns 404 PDF_NOT_GENERATED when no PDF exists', async () => {
      txState.pdfS3Key = null
      const res = await app.handle(makeRequest('GET', `/orders/${ORDER_ID}/pdf`, salesmanToken))
      expect(res.status).toBe(404)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('PDF_NOT_GENERATED')
    })

    it('generates + uploads a PDF and returns a download URL on POST /orders/:id/pdf', async () => {
      const res = await app.handle(makeRequest('POST', `/orders/${ORDER_ID}/pdf`, salesmanToken))
      expect(res.status).toBe(201)
      const body = (await res.json()) as PdfBody
      expect(body.data.pdf_url).toBeDefined()
      expect(body.data.expires_in).toBe(3600)
    })
  })

  describe('Unauthenticated requests', () => {
    it('returns 401 when no token is provided', async () => {
      // GET carries no body, so it reaches the auth guard without tripping body validation
      const res = await app.handle(new Request('http://localhost/orders', { method: 'GET' }))
      expect(res.status).toBe(401)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('UNAUTHORIZED')
    })
  })
})
