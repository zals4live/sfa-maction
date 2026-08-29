import { describe, it, expect } from 'bun:test'

import { assertNoOpenVisit, ServiceError } from '../service'

describe('visit/service', () => {
  describe('assertNoOpenVisit (concurrent visit lock)', () => {
    it('should throw VISIT_ALREADY_OPEN (409) when an open visit exists today', async () => {
      const mockTx = createMockTx([{ id: 'open-visit-id' }])

      try {
        await assertNoOpenVisit(mockTx as any, 'company-1', 'user-1')
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError)
        const serviceErr = err as ServiceError
        expect(serviceErr.code).toBe('VISIT_ALREADY_OPEN')
        expect(serviceErr.status).toBe(409)
        expect(serviceErr.message).toBe(
          'You have an open visit that must be completed before starting a new one.'
        )
      }
    })

    it('should not throw when no open visits exist today', async () => {
      const mockTx = createMockTx([])

      await expect(
        assertNoOpenVisit(mockTx as any, 'company-1', 'user-1')
      ).resolves.toBeUndefined()
    })

    it('should not block when only completed visits exist (visit_out_at is set)', async () => {
      // The query filters for isNull(visits.visitOutAt), so completed visits
      // are excluded from results. An empty result means no open visits.
      const mockTx = createMockTx([])

      await expect(
        assertNoOpenVisit(mockTx as any, 'company-1', 'user-1')
      ).resolves.toBeUndefined()
    })

    it('should not block when open visits exist from previous days (only today matters)', async () => {
      // The query filters by eq(visits.visitDate, today), so visits from
      // other days are excluded. An empty result means no blocking.
      const mockTx = createMockTx([])

      await expect(
        assertNoOpenVisit(mockTx as any, 'company-1', 'user-1')
      ).resolves.toBeUndefined()
    })

    it('should isolate by company_id — open visits from other companies do not block', async () => {
      // The query includes eq(visits.companyId, companyId) so other tenants' visits
      // are excluded. An empty result means no conflict.
      const mockTx = createMockTx([])

      await expect(
        assertNoOpenVisit(mockTx as any, 'company-2', 'user-1')
      ).resolves.toBeUndefined()
    })

    it('should isolate by user_id — open visits from other users do not block', async () => {
      // The query includes eq(visits.userId, userId) so other users' open visits
      // don't affect this user. An empty result means no conflict.
      const mockTx = createMockTx([])

      await expect(
        assertNoOpenVisit(mockTx as any, 'company-1', 'user-2')
      ).resolves.toBeUndefined()
    })
  })
})

/**
 * Creates a minimal mock transaction that simulates Drizzle's query builder chain.
 * Returns the provided rows as the query result after the `.limit()` call.
 */
function createMockTx(rows: Array<{ id: string }>) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  }
  return chain
}
