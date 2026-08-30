import { describe, it, expect } from 'bun:test'

import {
  computeStrikeRate,
  buildBranchPerformanceMatrix,
} from '../branchPerformance'

describe('report/branchPerformance — computeStrikeRate', () => {
  it('should compute (orders / visits) * 100 rounded to 2 decimals', () => {
    expect(computeStrikeRate(3, 4)).toBe(75)
    expect(computeStrikeRate(1, 3)).toBe(33.33)
  })

  it('should return 0 when total visits is zero to avoid division by zero', () => {
    expect(computeStrikeRate(5, 0)).toBe(0)
    expect(computeStrikeRate(0, 0)).toBe(0)
  })
})

describe('report/branchPerformance — buildBranchPerformanceMatrix', () => {
  it('should rank branches by revenue then assign sequential ranks', () => {
    const rows = buildBranchPerformanceMatrix(
      [
        {
          soffice_id: 's-low',
          soffice_name: 'Low Branch',
          total_visits: '10',
          total_revenue: '1000',
          orders_from_visits: '2',
        },
        {
          soffice_id: 's-high',
          soffice_name: 'High Branch',
          total_visits: '20',
          total_revenue: '5000',
          orders_from_visits: '8',
        },
      ],
      []
    )

    expect(rows.map((r) => r.soffice_id)).toEqual(['s-high', 's-low'])
    expect(rows[0]!.rank).toBe(1)
    expect(rows[1]!.rank).toBe(2)
  })

  it('should compute branch strike rate from orders and visits', () => {
    const rows = buildBranchPerformanceMatrix(
      [
        {
          soffice_id: 's1',
          soffice_name: 'Branch 1',
          total_visits: 20,
          total_revenue: 5000,
          orders_from_visits: 5,
        },
      ],
      []
    )

    expect(rows[0]!.strike_rate_pct).toBe(25)
  })

  it('should segment SALESMAN and MR metrics per branch', () => {
    const rows = buildBranchPerformanceMatrix(
      [
        {
          soffice_id: 's1',
          soffice_name: 'Branch 1',
          total_visits: 30,
          total_revenue: 5000,
          orders_from_visits: 6,
        },
      ],
      [
        { soffice_id: 's1', role_label: 'SALESMAN', total_visits: '20', effective_calls: '10' },
        { soffice_id: 's1', role_label: 'MR', total_visits: '10', effective_calls: '2' },
      ]
    )

    expect(rows[0]!.SALESMAN).toEqual({ total_visits: 20, effective_calls: 10, call_rate_pct: 50 })
    expect(rows[0]!.MR).toEqual({ total_visits: 10, effective_calls: 2, call_rate_pct: 20 })
  })

  it('should default missing role metrics to zeroed blocks', () => {
    const rows = buildBranchPerformanceMatrix(
      [
        {
          soffice_id: 's1',
          soffice_name: 'Branch 1',
          total_visits: 5,
          total_revenue: 100,
          orders_from_visits: 1,
        },
      ],
      [{ soffice_id: 's1', role_label: 'SALESMAN', total_visits: 5, effective_calls: 1 }]
    )

    expect(rows[0]!.MR).toEqual({ total_visits: 0, effective_calls: 0, call_rate_pct: 0 })
  })

  it('should break revenue ties by visits then strike rate', () => {
    const rows = buildBranchPerformanceMatrix(
      [
        {
          soffice_id: 's-fewer-visits',
          soffice_name: 'Fewer',
          total_visits: 10,
          total_revenue: 1000,
          orders_from_visits: 5,
        },
        {
          soffice_id: 's-more-visits',
          soffice_name: 'More',
          total_visits: 20,
          total_revenue: 1000,
          orders_from_visits: 5,
        },
      ],
      []
    )

    expect(rows[0]!.soffice_id).toBe('s-more-visits')
  })

  it('should return an empty matrix when there are no branches', () => {
    expect(buildBranchPerformanceMatrix([], [])).toEqual([])
  })

  it('should ignore role rows with unexpected labels', () => {
    const rows = buildBranchPerformanceMatrix(
      [
        {
          soffice_id: 's1',
          soffice_name: 'Branch 1',
          total_visits: 5,
          total_revenue: 100,
          orders_from_visits: 1,
        },
      ],
      [{ soffice_id: 's1', role_label: 'ADMIN_PUSAT', total_visits: 99, effective_calls: 99 }]
    )

    expect(rows[0]!.SALESMAN.total_visits).toBe(0)
    expect(rows[0]!.MR.total_visits).toBe(0)
  })
})
