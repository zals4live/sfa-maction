import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'

/**
 * Integration test (Phase 16) — concurrent session invalidation (single-session).
 *
 * KF Maction enforces a single active session per user (see security steering:
 * "Single Active Session — new login invalidates prior session via Redis"). The
 * session key is per-user (`session:{company_id}:{user_id}`, see config/session.ts),
 * NOT per-token, so logging in from a second device overwrites the first device's
 * session. tenantGuard (middleware/tenantGuard.ts) gates every protected route by
 * confirming that key still exists in Redis; once overwritten, the first device's
 * JWT — though cryptographically still valid and unexpired — no longer resolves to a
 * live session and is rejected with 401 SESSION_INVALIDATED.
 *
 * This test exercises the REAL login service (src/modules/auth/service.ts), the REAL
 * session helpers (src/config/session.ts) and the REAL tenantGuard route flow
 * end-to-end. Only the external dependencies are mocked, per testing convention:
 *   - Redis: a stateful in-memory store so deleteSession/createSession (login) and
 *     getSession (tenantGuard) share one source of truth and genuinely prove overwrite.
 *   - db: returns a deterministic user row + lini assignments; the session-IP UPDATE
 *     is a no-op.
 *   - Bun.password.verify: accepts the known test password.
 *
 * Nothing hits a live Redis/PostgreSQL, so the test is hermetic and leaves no artifacts.
 */

const TEST_SECRET = 'test-secret-key-for-unit-tests'
process.env['JWT_SECRET'] = TEST_SECRET

const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const SOFFICE_ID = '770e8400-e29b-41d4-a716-446655440002'
const LINI_ID = '880e8400-e29b-41d4-a716-446655440003'

const TEST_EMAIL = 'salesman@test.local'
const TEST_PASSWORD = 'correct-horse-battery-staple'

const DEVICE_A_IP = '10.0.0.1'
const DEVICE_B_IP = '10.0.0.2'

// --- Stateful in-memory Redis mock (shared by session.ts create/delete/get) ---
// Models exactly the SET/GET/DEL surface config/session.ts uses.
const store = new Map<string, string>()

mock.module('../../../config/redis', () => ({
  redis: {
    set: async (key: string, value: string): Promise<'OK'> => {
      store.set(key, value)
      return 'OK'
    },
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    del: async (key: string): Promise<number> => (store.delete(key) ? 1 : 0),
  },
}))

// --- Mock the DB used by the auth service (findUserByEmail/ById, lini, IP update) ---
function userRow(): Record<string, unknown> {
  return {
    id: USER_ID,
    companyId: COMPANY_ID,
    sofficeId: SOFFICE_ID,
    email: TEST_EMAIL,
    passwordHash: '$argon2-mock-hash', // verify() is mocked below
    fullName: 'Test Salesman',
    phoneNumber: null,
    roleLabel: 'SALESMAN',
    avatarS3Key: null,
    currentSessionIp: null,
    isActive: true,
    isDeleted: false,
  }
}

/**
 * A chainable/awaitable query node. `.where(...).limit(...)` resolves to the user
 * lookup rows; awaiting after `.where(...)` (the lini-assignment query has no limit)
 * resolves to the lini rows. The projection passed to `.select()` disambiguates.
 */
function makeSelectNode(isLiniQuery: boolean): Record<string, unknown> {
  const rows = () => (isLiniQuery ? [{ liniId: LINI_ID }] : [userRow()])
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    limit: () => Promise.resolve(rows()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(onFulfilled, onRejected),
  }
  return node
}

mock.module('../../../db', () => ({
  db: {
    // fetchLiniIds selects { liniId: ... }; user lookups select the whole row (no projection).
    select: (projection?: Record<string, unknown>) =>
      makeSelectNode(!!projection && Object.keys(projection).includes('liniId')),
    // updateSessionIp: update(...).set(...).where(...) — resolves to nothing meaningful.
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  },
}))

// Accept the known test password; reject anything else (mirrors real verify contract).
const originalVerify = Bun.password.verify
;(Bun.password as unknown as { verify: unknown }).verify = mock(
  async (password: string): Promise<boolean> => password === TEST_PASSWORD
)

const { authRoutes } = await import('../routes')
const { buildSessionKey } = await import('../../../config/session')

interface LoginBody {
  data: { token: string; user: { id: string; role_label: string } }
}
interface MeBody {
  data: { id: string }
}
interface ErrorBody {
  error: { code: string; message: string }
}

// signJWT stamps iat/exp at whole-second resolution, so two logins within the same
// wall-clock second mint byte-identical tokens. Real devices log in seconds apart; we
// reproduce that by advancing a controlled clock so token A and token B are distinct
// and independently verifiable.
const realDateNow = Date.now.bind(Date)
let clockOffsetMs = 0
Date.now = () => realDateNow() + clockOffsetMs
function advanceClock(seconds: number): void {
  clockOffsetMs += seconds * 1000
}

/** POST /auth/login from a given device IP (via X-Forwarded-For). */
async function loginFrom(ip: string): Promise<Response> {
  return authRoutes.handle(
    new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
  )
}

/** GET /auth/me carrying a bearer token. */
async function getMe(token: string): Promise<Response> {
  return authRoutes.handle(
    new Request('http://localhost/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
  )
}

describe('auth — concurrent session invalidation (login from two devices)', () => {
  beforeEach(() => {
    store.clear()
    clockOffsetMs = 0
  })

  // Restore the real globals so no other suite inherits the stubs.
  afterAll(() => {
    ;(Bun.password as unknown as { verify: unknown }).verify = originalVerify
    Date.now = realDateNow
  })

  it('invalidates device A when the same user logs in from device B', async () => {
    // 1. Device A logs in → token A + a live Redis session for the user.
    const resA = await loginFrom(DEVICE_A_IP)
    expect(resA.status).toBe(200)
    const bodyA = (await resA.json()) as LoginBody
    const tokenA = bodyA.data.token
    expect(tokenA).toBeTruthy()
    expect(bodyA.data.user.id).toBe(USER_ID)

    // Session established under the per-user key.
    const sessionKey = buildSessionKey(COMPANY_ID, USER_ID)
    expect(store.has(sessionKey)).toBe(true)
    expect(JSON.parse(store.get(sessionKey)!).ip).toBe(DEVICE_A_IP)

    // Token A currently authorizes protected requests.
    const meABefore = await getMe(tokenA)
    expect(meABefore.status).toBe(200)
    expect(((await meABefore.json()) as MeBody).data.id).toBe(USER_ID)

    // 2. Device B logs in as the SAME user (seconds later) → token B; prior overwritten.
    advanceClock(2)
    const resB = await loginFrom(DEVICE_B_IP)
    expect(resB.status).toBe(200)
    const tokenB = (await resB.json() as LoginBody).data.token
    expect(tokenB).toBeTruthy()
    expect(tokenB).not.toBe(tokenA)

    // Exactly one session remains, now bound to device B's IP (single-session).
    expect(store.size).toBe(1)
    expect(JSON.parse(store.get(sessionKey)!).ip).toBe(DEVICE_B_IP)

    // 3. Token A no longer authorizes protected requests → 401 SESSION_INVALIDATED.
    const meAAfter = await getMe(tokenA)
    expect(meAAfter.status).toBe(401)
    const errBody = (await meAAfter.json()) as ErrorBody
    expect(errBody.error.code).toBe('SESSION_INVALIDATED')

    // 4. Token B remains valid.
    const meB = await getMe(tokenB)
    expect(meB.status).toBe(200)
    expect(((await meB.json()) as MeBody).data.id).toBe(USER_ID)
  })

  it('rejects a token with no backing session (logout / expiry parity)', async () => {
    // Log in, then simulate the session vanishing from Redis (e.g. explicit logout
    // or TTL expiry). The still-valid JWT must be rejected exactly like a superseded one.
    const res = await loginFrom(DEVICE_A_IP)
    const token = (await res.json() as LoginBody).data.token

    store.clear() // session gone; JWT untouched

    const me = await getMe(token)
    expect(me.status).toBe(401)
    expect(((await me.json()) as ErrorBody).error.code).toBe('SESSION_INVALIDATED')
  })
})
