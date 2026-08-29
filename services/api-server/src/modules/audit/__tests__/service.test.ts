import { describe, it, expect, mock, beforeEach } from 'bun:test'

// --- Track mock state ---
let capturedRlsCtx: unknown = null
let capturedRows: unknown[] = []
let insertCalled = false
let shouldThrow = false

mock.module('../../../db', () => ({
  withRLS: async (ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    capturedRlsCtx = ctx
    if (shouldThrow) throw new Error('db failure')
    const tx = {
      insert: () => ({
        values: (rows: unknown[]) => {
          insertCalled = true
          capturedRows = rows
          return Promise.resolve()
        },
      }),
    }
    return cb(tx)
  },
}))

const { logMutations, recordMutations } = await import('../service')

const baseCtx = {
  companyId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  userRole: 'SALESMAN',
  clientIp: '203.0.113.7',
  userAgent: 'Maction-PWA/2.0',
}

const insertMutation = {
  entityName: 'orders',
  recordId: '33333333-3333-3333-3333-333333333333',
  actionType: 'INSERT' as const,
  afterSnapshot: { orderNumber: 'SO-001' },
  beforeSnapshot: { stale: true },
}

describe('audit service', () => {
  beforeEach(() => {
    capturedRlsCtx = null
    capturedRows = []
    insertCalled = false
    shouldThrow = false
  })

  describe('logMutations', () => {
    it('sets RLS context from tenant + user + role', async () => {
      await logMutations(baseCtx, [insertMutation])

      expect(capturedRlsCtx).toEqual({
        companyId: baseCtx.companyId,
        userId: baseCtx.userId,
        userRole: baseCtx.userRole,
      })
    })

    it('persists company_id, user_id, client_ip and user_agent on the row', async () => {
      await logMutations(baseCtx, [insertMutation])

      const row = capturedRows[0] as Record<string, unknown>
      expect(row.companyId).toBe(baseCtx.companyId)
      expect(row.userId).toBe(baseCtx.userId)
      expect(row.clientIp).toBe(baseCtx.clientIp)
      expect(row.userAgent).toBe(baseCtx.userAgent)
      expect(row.entityName).toBe('orders')
      expect(row.recordId).toBe(insertMutation.recordId)
      expect(row.actionType).toBe('INSERT')
    })

    it('nulls beforeSnapshot for INSERT actions', async () => {
      await logMutations(baseCtx, [insertMutation])

      const row = capturedRows[0] as Record<string, unknown>
      expect(row.beforeSnapshot).toBeNull()
      expect(row.afterSnapshot).toEqual({ orderNumber: 'SO-001' })
    })

    it('nulls afterSnapshot for DELETE actions', async () => {
      await logMutations(baseCtx, [
        {
          entityName: 'master_customer',
          recordId: '44444444-4444-4444-4444-444444444444',
          actionType: 'DELETE',
          beforeSnapshot: { name: 'Apotek A' },
          afterSnapshot: { leftover: true },
        },
      ])

      const row = capturedRows[0] as Record<string, unknown>
      expect(row.beforeSnapshot).toEqual({ name: 'Apotek A' })
      expect(row.afterSnapshot).toBeNull()
    })

    it('retains both snapshots for UPDATE actions', async () => {
      await logMutations(baseCtx, [
        {
          entityName: 'orders',
          recordId: '55555555-5555-5555-5555-555555555555',
          actionType: 'UPDATE',
          beforeSnapshot: { status: 'DRAFT' },
          afterSnapshot: { status: 'SUBMITTED' },
        },
      ])

      const row = capturedRows[0] as Record<string, unknown>
      expect(row.beforeSnapshot).toEqual({ status: 'DRAFT' })
      expect(row.afterSnapshot).toEqual({ status: 'SUBMITTED' })
    })

    it('batches multiple mutations into a single insert call', async () => {
      await logMutations(baseCtx, [
        insertMutation,
        { ...insertMutation, recordId: '66666666-6666-6666-6666-666666666666' },
      ])

      expect(capturedRows).toHaveLength(2)
    })

    it('is a no-op for an empty mutation list', async () => {
      await logMutations(baseCtx, [])

      expect(insertCalled).toBe(false)
    })

    it('coalesces missing client_ip / user_agent to null', async () => {
      await logMutations(
        { companyId: baseCtx.companyId, userId: baseCtx.userId, userRole: 'MR' },
        [insertMutation],
      )

      const row = capturedRows[0] as Record<string, unknown>
      expect(row.clientIp).toBeNull()
      expect(row.userAgent).toBeNull()
    })
  })

  describe('recordMutations', () => {
    it('swallows DB errors so the audit trail never breaks the request', async () => {
      shouldThrow = true

      expect(() => recordMutations(baseCtx, [insertMutation])).not.toThrow()
      // Allow the swallowed promise rejection to settle.
      await Promise.resolve()
    })
  })
})
