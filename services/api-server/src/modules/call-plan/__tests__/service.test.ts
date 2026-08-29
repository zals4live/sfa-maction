import { describe, it, expect } from 'bun:test'

import { calculateCallRate, buildRoleSummary, classifyVisitType } from '../service'
import type { ClassifyVisitTypeParams, VisitTypeResult } from '../service'

describe('call-plan/service', () => {
  describe('calculateCallRate', () => {
    it('should compute (actual / planned) × 100 with 2 decimal precision', () => {
      expect(calculateCallRate(7, 10)).toBe(70)
      expect(calculateCallRate(1, 3)).toBe(33.33)
      expect(calculateCallRate(2, 3)).toBe(66.67)
    })

    it('should return 0 when no plans exist (division by zero guard)', () => {
      expect(calculateCallRate(0, 0)).toBe(0)
      expect(calculateCallRate(5, 0)).toBe(0)
    })

    it('should return 100 when all plans are visited', () => {
      expect(calculateCallRate(20, 20)).toBe(100)
    })

    it('should handle visits exceeding plans (over 100%)', () => {
      expect(calculateCallRate(15, 10)).toBe(150)
    })

    it('should return 0 when no visits and plans exist', () => {
      expect(calculateCallRate(0, 10)).toBe(0)
    })
  })

  describe('buildRoleSummary', () => {
    it('should correctly segment and aggregate by SALESMAN vs MR role', () => {
      const data = [
        { role_label: 'SALESMAN' as const, total_planned: 10, total_visited: 8 },
        { role_label: 'SALESMAN' as const, total_planned: 20, total_visited: 15 },
        { role_label: 'MR' as const, total_planned: 12, total_visited: 10 },
        { role_label: 'MR' as const, total_planned: 8, total_visited: 6 },
      ]

      const summary = buildRoleSummary(data)

      expect(summary.SALESMAN.total_planned).toBe(30)
      expect(summary.SALESMAN.total_visited).toBe(23)
      expect(summary.SALESMAN.call_rate_pct).toBe(76.67)

      expect(summary.MR.total_planned).toBe(20)
      expect(summary.MR.total_visited).toBe(16)
      expect(summary.MR.call_rate_pct).toBe(80)
    })

    it('should return zeroes when no data for a role', () => {
      const data = [
        { role_label: 'SALESMAN' as const, total_planned: 5, total_visited: 3 },
      ]

      const summary = buildRoleSummary(data)

      expect(summary.SALESMAN.total_planned).toBe(5)
      expect(summary.SALESMAN.total_visited).toBe(3)
      expect(summary.SALESMAN.call_rate_pct).toBe(60)

      expect(summary.MR.total_planned).toBe(0)
      expect(summary.MR.total_visited).toBe(0)
      expect(summary.MR.call_rate_pct).toBe(0)
    })

    it('should return zeroes for both roles when data is empty', () => {
      const summary = buildRoleSummary([])

      expect(summary.SALESMAN).toEqual({ total_planned: 0, total_visited: 0, call_rate_pct: 0 })
      expect(summary.MR).toEqual({ total_planned: 0, total_visited: 0, call_rate_pct: 0 })
    })

    it('should handle single user per role correctly', () => {
      const data = [
        { role_label: 'SALESMAN' as const, total_planned: 100, total_visited: 95 },
        { role_label: 'MR' as const, total_planned: 50, total_visited: 48 },
      ]

      const summary = buildRoleSummary(data)

      expect(summary.SALESMAN.call_rate_pct).toBe(95)
      expect(summary.MR.call_rate_pct).toBe(96)
    })
  })
})


describe('classifyVisitType', () => {
  it('should be exported as a function', () => {
    expect(typeof classifyVisitType).toBe('function')
  })

  it('should accept ClassifyVisitTypeParams with required fields', () => {
    const params: ClassifyVisitTypeParams = {
      companyId: '123e4567-e89b-12d3-a456-426614174000',
      userId: '123e4567-e89b-12d3-a456-426614174001',
      customerId: '123e4567-e89b-12d3-a456-426614174002',
      outletId: '123e4567-e89b-12d3-a456-426614174003',
      visitDate: '2024-06-15',
    }

    expect(params.companyId).toBeDefined()
    expect(params.userId).toBeDefined()
    expect(params.customerId).toBeDefined()
    expect(params.outletId).toBeDefined()
    expect(params.visitDate).toBeDefined()
  })

  it('should accept null outletId for doctor-only visits', () => {
    const params: ClassifyVisitTypeParams = {
      companyId: '123e4567-e89b-12d3-a456-426614174000',
      userId: '123e4567-e89b-12d3-a456-426614174001',
      customerId: '123e4567-e89b-12d3-a456-426614174002',
      outletId: null,
      visitDate: '2024-06-15',
    }

    expect(params.outletId).toBeNull()
  })

  it('should return PLANNED when a matching plan record is found (via mock tx)', async () => {
    const mockTx = createMockTx([{ id: 'some-plan-id' }])

    const result = await classifyVisitType(
      {
        companyId: '123e4567-e89b-12d3-a456-426614174000',
        userId: '123e4567-e89b-12d3-a456-426614174001',
        customerId: '123e4567-e89b-12d3-a456-426614174002',
        outletId: '123e4567-e89b-12d3-a456-426614174003',
        visitDate: '2024-06-15',
      },
      mockTx as any
    )

    expect(result).toBe('PLANNED')
  })

  it('should return EXTRA when no matching plan record exists (via mock tx)', async () => {
    const mockTx = createMockTx([])

    const result = await classifyVisitType(
      {
        companyId: '123e4567-e89b-12d3-a456-426614174000',
        userId: '123e4567-e89b-12d3-a456-426614174001',
        customerId: '123e4567-e89b-12d3-a456-426614174002',
        outletId: null,
        visitDate: '2024-06-15',
      },
      mockTx as any
    )

    expect(result).toBe('EXTRA')
  })

  it('should return valid VisitTypeResult values only', async () => {
    const validValues: VisitTypeResult[] = ['PLANNED', 'EXTRA']

    const mockTxPlanned = createMockTx([{ id: 'plan-1' }])
    const result1 = await classifyVisitType(
      {
        companyId: 'c1',
        userId: 'u1',
        customerId: 'cust1',
        outletId: 'o1',
        visitDate: '2024-01-01',
      },
      mockTxPlanned as any
    )
    expect(validValues).toContain(result1)

    const mockTxExtra = createMockTx([])
    const result2 = await classifyVisitType(
      {
        companyId: 'c1',
        userId: 'u1',
        customerId: 'cust1',
        outletId: 'o1',
        visitDate: '2024-01-01',
      },
      mockTxExtra as any
    )
    expect(validValues).toContain(result2)
  })
})

/**
 * Creates a minimal mock transaction that simulates Drizzle's query builder chain.
 * Returns the provided rows as the query result.
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
