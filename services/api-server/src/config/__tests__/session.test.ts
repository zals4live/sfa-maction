import { describe, it, expect, afterAll, beforeEach } from 'bun:test'
import { redis } from '../redis'
import {
  buildSessionKey,
  createSession,
  getSession,
  deleteSession,
  SESSION_TTL_FIELD,
  SESSION_TTL_ADMIN,
} from '../session'
import type { SessionData } from '../session'

const TEST_COMPANY = '00000000-0000-0000-0000-000000000001'
const TEST_USER = '00000000-0000-0000-0000-000000000002'
const TEST_PREFIX = 'session'

function makeSessionData(overrides?: Partial<SessionData>): SessionData {
  return {
    company_id: TEST_COMPANY,
    user_id: TEST_USER,
    soffice_id: '00000000-0000-0000-0000-000000000003',
    role_label: 'SALESMAN',
    ip: '192.168.1.100',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('session config', () => {
  const keysToCleanup: string[] = []

  beforeEach(async () => {
    // Clean up any leftover test keys before each test
    const key = buildSessionKey(TEST_COMPANY, TEST_USER)
    await redis.del(key)
  })

  afterAll(async () => {
    // Clean up all tracked keys
    for (const key of keysToCleanup) {
      await redis.del(key)
    }
    // Also clean the default test key
    await redis.del(buildSessionKey(TEST_COMPANY, TEST_USER))
  })

  describe('buildSessionKey', () => {
    it('produces correct key format: session:{company_id}:{user_id}', () => {
      const key = buildSessionKey(TEST_COMPANY, TEST_USER)
      expect(key).toBe(`${TEST_PREFIX}:${TEST_COMPANY}:${TEST_USER}`)
    })

    it('handles different UUIDs correctly', () => {
      const companyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const userId = '11111111-2222-3333-4444-555555555555'
      const key = buildSessionKey(companyId, userId)
      expect(key).toBe(`session:${companyId}:${userId}`)
    })
  })

  describe('createSession → getSession round trip', () => {
    it('stores and retrieves session data correctly', async () => {
      const data = makeSessionData()
      await createSession(TEST_COMPANY, TEST_USER, data, 60)

      const retrieved = await getSession(TEST_COMPANY, TEST_USER)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.company_id).toBe(TEST_COMPANY)
      expect(retrieved!.user_id).toBe(TEST_USER)
      expect(retrieved!.role_label).toBe('SALESMAN')
      expect(retrieved!.ip).toBe('192.168.1.100')
    })

    it('returns null for a non-existent session', async () => {
      const result = await getSession(
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'ffffffff-ffff-ffff-ffff-fffffffffff0'
      )
      expect(result).toBeNull()
    })
  })

  describe('deleteSession', () => {
    it('removes the session from Redis', async () => {
      const data = makeSessionData()
      await createSession(TEST_COMPANY, TEST_USER, data, 60)

      // Verify it exists
      const before = await getSession(TEST_COMPANY, TEST_USER)
      expect(before).not.toBeNull()

      // Delete
      await deleteSession(TEST_COMPANY, TEST_USER)

      // Verify it's gone
      const after = await getSession(TEST_COMPANY, TEST_USER)
      expect(after).toBeNull()
    })

    it('does not throw when deleting a non-existent session', async () => {
      // Should not throw
      await deleteSession(
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        'ffffffff-ffff-ffff-ffff-fffffffffff0'
      )
    })
  })

  describe('single-session enforcement (overwrite on re-login)', () => {
    it('overwrites previous session when createSession is called again for same user', async () => {
      const firstSession = makeSessionData({ ip: '10.0.0.1', created_at: '2024-01-01T00:00:00Z' })
      const secondSession = makeSessionData({ ip: '10.0.0.2', created_at: '2024-01-01T01:00:00Z' })

      await createSession(TEST_COMPANY, TEST_USER, firstSession, 60)
      const afterFirst = await getSession(TEST_COMPANY, TEST_USER)
      expect(afterFirst!.ip).toBe('10.0.0.1')

      // Simulate new login — overwrite with new session
      await createSession(TEST_COMPANY, TEST_USER, secondSession, 60)
      const afterSecond = await getSession(TEST_COMPANY, TEST_USER)
      expect(afterSecond!.ip).toBe('10.0.0.2')
      expect(afterSecond!.created_at).toBe('2024-01-01T01:00:00Z')
    })
  })

  describe('session TTL expiration', () => {
    it('expires session after TTL elapses', async () => {
      const data = makeSessionData()
      // Use a 1-second TTL for testing
      await createSession(TEST_COMPANY, TEST_USER, data, 1)

      // Should exist immediately
      const immediate = await getSession(TEST_COMPANY, TEST_USER)
      expect(immediate).not.toBeNull()

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Should be gone after TTL
      const expired = await getSession(TEST_COMPANY, TEST_USER)
      expect(expired).toBeNull()
    })
  })

  describe('TTL constants', () => {
    it('SESSION_TTL_FIELD is 24 hours (86400 seconds)', () => {
      expect(SESSION_TTL_FIELD).toBe(86400)
    })

    it('SESSION_TTL_ADMIN is 8 hours (28800 seconds)', () => {
      expect(SESSION_TTL_ADMIN).toBe(28800)
    })
  })
})
