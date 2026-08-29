import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  buildSessionKey,
  createSession,
  getSession,
  deleteSession,
  SESSION_TTL_FIELD,
  SESSION_TTL_ADMIN,
  type SessionData,
} from '../../../config/session'
import { redis } from '../../../config/redis'

const TEST_COMPANY_ID = '11111111-1111-1111-1111-111111111111'
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222'
const TEST_USER_ID_2 = '33333333-3333-3333-3333-333333333333'

const testSessionData: SessionData = {
  company_id: TEST_COMPANY_ID,
  user_id: TEST_USER_ID,
  soffice_id: '44444444-4444-4444-4444-444444444444',
  role_label: 'SALESMAN',
  ip: '192.168.1.1',
  created_at: new Date().toISOString(),
}

describe('Session Management Utilities', () => {
  afterEach(async () => {
    const key = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID)
    const key2 = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID_2)
    await redis.del(key, key2)
  })

  describe('buildSessionKey', () => {
    it('should build correct key pattern', () => {
      const key = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID)
      expect(key).toBe(`session:${TEST_COMPANY_ID}:${TEST_USER_ID}`)
    })
  })

  describe('createSession', () => {
    it('should store session in Redis with TTL', async () => {
      await createSession(TEST_COMPANY_ID, TEST_USER_ID, testSessionData, SESSION_TTL_FIELD)

      const key = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID)
      const raw = await redis.get(key)
      expect(raw).not.toBeNull()

      const parsed = JSON.parse(raw!)
      expect(parsed.company_id).toBe(TEST_COMPANY_ID)
      expect(parsed.user_id).toBe(TEST_USER_ID)
      expect(parsed.role_label).toBe('SALESMAN')

      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_FIELD)
    })

    it('should use admin TTL for admin roles', async () => {
      const adminSession: SessionData = {
        ...testSessionData,
        role_label: 'ADMIN_PUSAT',
      }
      await createSession(TEST_COMPANY_ID, TEST_USER_ID, adminSession, SESSION_TTL_ADMIN)

      const key = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID)
      const ttl = await redis.ttl(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(SESSION_TTL_ADMIN)
    })
  })

  describe('getSession', () => {
    it('should return session data when session exists', async () => {
      await createSession(TEST_COMPANY_ID, TEST_USER_ID, testSessionData, SESSION_TTL_FIELD)

      const session = await getSession(TEST_COMPANY_ID, TEST_USER_ID)
      expect(session).not.toBeNull()
      expect(session!.company_id).toBe(TEST_COMPANY_ID)
      expect(session!.user_id).toBe(TEST_USER_ID)
      expect(session!.role_label).toBe('SALESMAN')
      expect(session!.ip).toBe('192.168.1.1')
    })

    it('should return null when session does not exist', async () => {
      const session = await getSession(TEST_COMPANY_ID, 'nonexistent-user-id')
      expect(session).toBeNull()
    })
  })

  describe('deleteSession', () => {
    it('should remove session from Redis', async () => {
      await createSession(TEST_COMPANY_ID, TEST_USER_ID, testSessionData, SESSION_TTL_FIELD)

      await deleteSession(TEST_COMPANY_ID, TEST_USER_ID)

      const session = await getSession(TEST_COMPANY_ID, TEST_USER_ID)
      expect(session).toBeNull()
    })

    it('should not throw when deleting non-existent session', async () => {
      expect(
        deleteSession(TEST_COMPANY_ID, 'nonexistent-user-id')
      ).resolves.toBeUndefined()
    })
  })

  describe('TTL constants', () => {
    it('should have correct field force TTL (24h)', () => {
      expect(SESSION_TTL_FIELD).toBe(86400)
    })

    it('should have correct admin TTL (8h)', () => {
      expect(SESSION_TTL_ADMIN).toBe(28800)
    })
  })
})

describe('Tenant Kill-Switch — Redis Session Invalidation', () => {
  beforeEach(async () => {
    await createSession(TEST_COMPANY_ID, TEST_USER_ID, testSessionData, SESSION_TTL_FIELD)
    await createSession(
      TEST_COMPANY_ID,
      TEST_USER_ID_2,
      { ...testSessionData, user_id: TEST_USER_ID_2 },
      SESSION_TTL_FIELD
    )
  })

  afterEach(async () => {
    const key = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID)
    const key2 = buildSessionKey(TEST_COMPANY_ID, TEST_USER_ID_2)
    await redis.del(key, key2)
  })

  it('should invalidate all sessions for a company via SCAN pattern', async () => {
    const session1Before = await getSession(TEST_COMPANY_ID, TEST_USER_ID)
    const session2Before = await getSession(TEST_COMPANY_ID, TEST_USER_ID_2)
    expect(session1Before).not.toBeNull()
    expect(session2Before).not.toBeNull()

    await invalidateCompanySessionsViaRedis(TEST_COMPANY_ID)

    const session1After = await getSession(TEST_COMPANY_ID, TEST_USER_ID)
    const session2After = await getSession(TEST_COMPANY_ID, TEST_USER_ID_2)
    expect(session1After).toBeNull()
    expect(session2After).toBeNull()
  })

  it('should handle case where no sessions exist for a company', async () => {
    const emptyCompanyId = '99999999-9999-9999-9999-999999999999'
    expect(
      invalidateCompanySessionsViaRedis(emptyCompanyId)
    ).resolves.toBeUndefined()
  })
})

/**
 * Re-implements the SCAN-based invalidation matching the pattern in service.ts
 * to test the kill-switch logic independently.
 */
async function invalidateCompanySessionsViaRedis(companyId: string): Promise<void> {
  const pattern = `session:${companyId}:*`
  let cursor = '0'

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = nextCursor
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } while (cursor !== '0')
}
