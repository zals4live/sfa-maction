import { describe, it, expect, beforeAll } from 'bun:test'
import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'

const TEST_SECRET = 'test-secret-key-for-unit-tests'

// Must set env before importing tenantGuard (reads JWT_SECRET on load)
process.env['JWT_SECRET'] = TEST_SECRET

const { tenantGuard } = await import('../tenantGuard')

const validClaims = {
  user_id: '550e8400-e29b-41d4-a716-446655440000',
  company_id: '660e8400-e29b-41d4-a716-446655440001',
  soffice_id: '770e8400-e29b-41d4-a716-446655440002',
  role_label: 'SALESMAN',
  lini_ids: ['880e8400-e29b-41d4-a716-446655440003'],
}

/** Helper to sign a token with the test secret */
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

interface ErrorBody {
  error: { code: string; message: string }
}

interface SuccessBody {
  data: {
    user_id: string
    company_id: string
    soffice_id: string
    role_label: string
    lini_ids: string[]
  }
}

describe('tenantGuard middleware', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any

  beforeAll(() => {
    app = new Elysia()
      .use(tenantGuard)
      .get('/protected', ({ claims }) => ({ data: claims }))
  })

  it('returns 401 when no Authorization header is present', async () => {
    const res = await app.handle(new Request('http://localhost/protected'))
    expect(res.status).toBe(401)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('Missing')
  })

  it('returns 401 for malformed Authorization header', async () => {
    const res = await app.handle(
      new Request('http://localhost/protected', {
        headers: { Authorization: 'Basic abc123' },
      })
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 401 for an invalid/expired token', async () => {
    const res = await app.handle(
      new Request('http://localhost/protected', {
        headers: { Authorization: 'Bearer invalid.token.here' },
      })
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('Invalid or expired')
  })

  it('returns 401 when token is missing required claims', async () => {
    const token = await signToken({ user_id: 'not-a-uuid' })
    const res = await app.handle(
      new Request('http://localhost/protected', {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toContain('missing required claims')
  })

  it('derives claims into context on valid token', async () => {
    const token = await signToken(validClaims)
    const res = await app.handle(
      new Request('http://localhost/protected', {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as SuccessBody
    expect(body.data.user_id).toBe(validClaims.user_id)
    expect(body.data.company_id).toBe(validClaims.company_id)
    expect(body.data.soffice_id).toBe(validClaims.soffice_id)
    expect(body.data.role_label).toBe('SALESMAN')
    expect(body.data.lini_ids).toEqual(validClaims.lini_ids)
  })

  it('accepts MR role label', async () => {
    const mrClaims = { ...validClaims, role_label: 'MR' }
    const token = await signToken(mrClaims)
    const res = await app.handle(
      new Request('http://localhost/protected', {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as SuccessBody
    expect(body.data.role_label).toBe('MR')
  })

  it('rejects invalid role label', async () => {
    const badClaims = { ...validClaims, role_label: 'HACKER' }
    const token = await signToken(badClaims)
    const res = await app.handle(
      new Request('http://localhost/protected', {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('UNAUTHORIZED')
  })
})
