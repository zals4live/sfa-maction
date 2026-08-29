import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'test-secret-key-for-unit-tests'

// Must set env before importing modules that read JWT_SECRET
process.env['JWT_SECRET'] = TEST_SECRET

const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440002'
const IDEMPOTENCY_KEY = 'aa0e8400-e29b-41d4-a716-44665544000a'

// Mock Redis session lookup to always return a valid session (auth passes)
mock.module('../../../config/session', () => ({
  getSession: async () => ({
    company_id: COMPANY_ID,
    user_id: USER_ID,
    soffice_id: SOFFICE_ID,
    role_label: 'SUPER_ADMIN',
    ip: '127.0.0.1',
    created_at: new Date().toISOString(),
  }),
  createSession: async () => {},
  deleteSession: async () => {},
  buildSessionKey: (companyId: string, userId: string) => `session:${companyId}:${userId}`,
  SESSION_TTL_FIELD: 86400,
  SESSION_TTL_ADMIN: 28800,
}))

// --- Configurable Redis idempotency state ---
// `claimResult` controls the SET NX outcome: 'OK' = first delivery (claim won),
// null = key already present (duplicate delivery).
interface RedisState {
  claimResult: 'OK' | null
}

let redisState: RedisState

function resetRedisState(): void {
  redisState = { claimResult: 'OK' }
}

resetRedisState()

const setCalls: Array<unknown[]> = []

mock.module('../../../config/redis', () => ({
  redis: {
    set: (...args: unknown[]) => {
      setCalls.push(args)
      return Promise.resolve(redisState.claimResult)
    },
  },
}))

// withRLS invokes the callback with a lightweight fake tx. The customer apply
// now issues real queries, so the tx resolves a matching sales office (first
// select) and no existing customer (second select), driving the insert (created)
// path. This keeps route-level assertions focused on the envelope shape while
// the per-record upsert logic is covered in service.test.ts.
//
// Inbound audit rows are written via `tx.insert(auditErpSyncLogs).values(row)`
// (awaited directly, no `.returning()`), so the fake `insert().values()` result
// is BOTH a thenable AND exposes `.returning()` — supporting the customer upsert
// (which calls `.returning()`) and the audit write (which awaits values()). Rows
// are captured in `auditRows` for direction/type assertions.
let txSelectCount = 0
let auditRows: Array<Record<string, unknown>>

function resetAuditRows(): void {
  auditRows = []
}

resetAuditRows()

function makeRouteTx(): unknown {
  return {
    select: () => ({
      from: () => ({
        where: (): Promise<Array<{ id: string }>> => {
          const n = txSelectCount++
          // 0 = soffice lookup (found), 1 = existing customer lookup (none)
          return Promise.resolve(n === 0 ? [{ id: SOFFICE_ID }] : [])
        },
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        // Audit writes carry syncDirection; capture them for assertions. Customer
        // inserts don't, and additionally use `.returning()`.
        if (row && typeof row === 'object' && 'syncDirection' in row) {
          auditRows.push(row)
        }
        const thenable = Promise.resolve([{ id: 'cust-1' }]) as Promise<Array<{ id: string }>> & {
          returning: () => Promise<Array<{ id: string }>>
        }
        thenable.returning = () => Promise.resolve([{ id: 'cust-1' }])
        return thenable
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  }
}

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    txSelectCount = 0
    return cb(makeRouteTx())
  },
}))

const { erpSyncRoutes } = await import('../routes')

const baseClaims = {
  user_id: USER_ID,
  company_id: COMPANY_ID,
  soffice_id: SOFFICE_ID,
  lini_ids: ['880e8400-e29b-41d4-a716-446655440003'],
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

interface SyncBody {
  data: {
    idempotency_key: string
    duplicate: boolean
    received: number
    created: number
    updated: number
    failed: number
    errors: unknown[]
  }
}

const validCustomerBody = {
  idempotency_key: IDEMPOTENCY_KEY,
  records: [
    {
      erp_customer_code: 'CUST-001',
      soffice_code: 'SO-01',
      customer_type: 'OUTLET',
      name: 'Apotek Sehat',
    },
  ],
}

describe('ERP sync routes — RBAC & idempotency', () => {
  const app = erpSyncRoutes

  beforeEach(() => {
    resetRedisState()
    setCalls.length = 0
    resetAuditRows()
  })

  describe('Non-SUPER_ADMIN roles receive 403 Forbidden', () => {
    it('returns 403 on POST /erp/webhook/customers for MR', async () => {
      const token = await signToken({ ...baseClaims, role_label: 'MR' })
      const res = await app.handle(
        makeRequest('POST', '/erp/webhook/customers', token, validCustomerBody)
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /erp/webhook/materials for SALESMAN', async () => {
      const token = await signToken({ ...baseClaims, role_label: 'SALESMAN' })
      const res = await app.handle(
        makeRequest('POST', '/erp/webhook/materials', token, {
          idempotency_key: IDEMPOTENCY_KEY,
          records: [
            { erp_material_code: 'M-1', name: 'Paracetamol', base_uom: 'PCS', sales_uom: 'BOX', uom_conversion_rules: {} },
          ],
        })
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /erp/webhook/leads for ADMIN_CABANG', async () => {
      const token = await signToken({ ...baseClaims, role_label: 'ADMIN_CABANG' })
      const res = await app.handle(
        makeRequest('POST', '/erp/webhook/leads', token, {
          idempotency_key: IDEMPOTENCY_KEY,
          records: [
            { assignee_user_code: 'U-1', erp_customer_code: 'CUST-001', plan_date: '2025-01-01' },
          ],
        })
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })
  })

  describe('SUPER_ADMIN — valid payload returns the sync envelope', () => {
    let superToken: string

    beforeAll(async () => {
      superToken = await signToken({ ...baseClaims, role_label: 'SUPER_ADMIN' })
    })

    it('returns the ErpSyncResult envelope on first delivery (duplicate=false)', async () => {
      redisState.claimResult = 'OK'
      const res = await app.handle(
        makeRequest('POST', '/erp/webhook/customers', superToken, validCustomerBody)
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as SyncBody
      expect(body.data.idempotency_key).toBe(IDEMPOTENCY_KEY)
      expect(body.data.duplicate).toBe(false)
      expect(body.data.received).toBe(1)
      // customer apply now runs: soffice resolved + no existing row → inserted
      expect(body.data.created).toBe(1)
      expect(body.data.updated).toBe(0)
      expect(body.data.failed).toBe(0)
      expect(Array.isArray(body.data.errors)).toBe(true)
    })

    it('records an INBOUND audit_erp_sync_logs row for a successful sync', async () => {
      redisState.claimResult = 'OK'
      await app.handle(makeRequest('POST', '/erp/webhook/customers', superToken, validCustomerBody))
      expect(auditRows.length).toBe(1)
      const row = auditRows[0]!
      expect(row['syncDirection']).toBe('INBOUND')
      expect(row['syncType']).toBe('CUSTOMER_SYNC')
      expect(row['endpointUrl']).toBe('/erp/webhook/customers')
      expect(row['isSuccess']).toBe(true)
      expect(row['idempotencyKey']).toBe(IDEMPOTENCY_KEY)
      expect(row['companyId']).toBe(COMPANY_ID)
    })

    it('records an audit row even on a duplicate (already-processed) delivery', async () => {
      redisState.claimResult = null
      await app.handle(makeRequest('POST', '/erp/webhook/customers', superToken, validCustomerBody))
      expect(auditRows.length).toBe(1)
      expect(auditRows[0]?.['isSuccess']).toBe(true)
      expect(auditRows[0]?.['syncDirection']).toBe('INBOUND')
    })

    it('claims the idempotency key via Redis SET NX with a 24h TTL', async () => {
      redisState.claimResult = 'OK'
      await app.handle(makeRequest('POST', '/erp/webhook/customers', superToken, validCustomerBody))
      expect(setCalls.length).toBe(1)
      const args = setCalls[0]!
      // redis.set(key, '1', 'EX', 86400, 'NX')
      expect(args[2]).toBe('EX')
      expect(args[3]).toBe(86_400)
      expect(args[4]).toBe('NX')
    })

    it('returns duplicate=true when the idempotency_key was already processed', async () => {
      redisState.claimResult = null
      const res = await app.handle(
        makeRequest('POST', '/erp/webhook/customers', superToken, validCustomerBody)
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as SyncBody
      expect(body.data.duplicate).toBe(true)
      expect(body.data.received).toBe(1)
      expect(body.data.created).toBe(0)
    })

    it('rejects a malformed payload (missing idempotency_key) with 422', async () => {
      const res = await app.handle(
        makeRequest('POST', '/erp/webhook/customers', superToken, {
          records: validCustomerBody.records,
        })
      )
      expect(res.status).toBe(422)
    })
  })

  describe('Unauthenticated requests', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await app.handle(
        new Request('http://localhost/erp/webhook/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validCustomerBody),
        })
      )
      expect(res.status).toBe(401)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('UNAUTHORIZED')
    })
  })
})
