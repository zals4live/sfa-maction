import { describe, it, expect, beforeAll, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'test-secret-key-for-unit-tests'

// Must set env before importing modules that read JWT_SECRET
process.env['JWT_SECRET'] = TEST_SECRET

// Mock Redis session lookup to always return a valid session
mock.module('../../../config/session', () => ({
  getSession: async () => ({
    company_id: '660e8400-e29b-41d4-a716-446655440001',
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    soffice_id: '770e8400-e29b-41d4-a716-446655440002',
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

const { orderRoutes } = await import('../routes')

const baseClaims = {
  user_id: '550e8400-e29b-41d4-a716-446655440000',
  company_id: '660e8400-e29b-41d4-a716-446655440001',
  soffice_id: '770e8400-e29b-41d4-a716-446655440002',
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

function makeRequest(method: string, path: string, token: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  })
}

interface ErrorBody {
  error: { code: string; message: string }
}

describe('Order routes — MR role restriction', () => {
  let app: ReturnType<typeof orderRoutes['handle']> extends Promise<infer R> ? never : typeof orderRoutes

  beforeAll(() => {
    app = orderRoutes
  })

  describe('MR role receives 403 Forbidden', () => {
    let mrToken: string

    beforeAll(async () => {
      mrToken = await signToken({ ...baseClaims, role_label: 'MR' })
    })

    it('returns 403 on POST /orders for MR', async () => {
      const res = await app.handle(makeRequest('POST', '/orders', mrToken))
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
      const res = await app.handle(
        makeRequest('GET', '/orders/550e8400-e29b-41d4-a716-446655440000', mrToken)
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on POST /orders/:id/submit for MR', async () => {
      const res = await app.handle(
        makeRequest('POST', '/orders/550e8400-e29b-41d4-a716-446655440000/submit', mrToken)
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('FORBIDDEN')
    })

    it('returns 403 on GET /orders/:id/pdf for MR', async () => {
      const res = await app.handle(
        makeRequest('GET', '/orders/550e8400-e29b-41d4-a716-446655440000/pdf', mrToken)
      )
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

    it('returns 200 on POST /orders for SALESMAN', async () => {
      const res = await app.handle(makeRequest('POST', '/orders', salesmanToken))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toBeDefined()
      expect(body.data.status).toBe('DRAFT')
    })

    it('returns 200 on GET /orders for SALESMAN', async () => {
      const res = await app.handle(makeRequest('GET', '/orders', salesmanToken))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toBeDefined()
      expect(body.meta).toBeDefined()
    })

    it('returns 200 on GET /orders/:id for SALESMAN', async () => {
      const res = await app.handle(
        makeRequest('GET', '/orders/550e8400-e29b-41d4-a716-446655440000', salesmanToken)
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.id).toBe('550e8400-e29b-41d4-a716-446655440000')
    })

    it('returns 200 on POST /orders/:id/submit for SALESMAN', async () => {
      const res = await app.handle(
        makeRequest('POST', '/orders/550e8400-e29b-41d4-a716-446655440000/submit', salesmanToken)
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.status).toBe('SUBMITTED')
    })

    it('returns 200 on GET /orders/:id/pdf for SALESMAN', async () => {
      const res = await app.handle(
        makeRequest('GET', '/orders/550e8400-e29b-41d4-a716-446655440000/pdf', salesmanToken)
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.pdf_url).toBeDefined()
    })
  })

  describe('Unauthenticated requests', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await app.handle(
        new Request('http://localhost/orders', { method: 'POST' })
      )
      expect(res.status).toBe(401)
      const body = (await res.json()) as ErrorBody
      expect(body.error.code).toBe('UNAUTHORIZED')
    })
  })
})
