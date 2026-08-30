import { describe, it, expect, mock, beforeEach } from 'bun:test'

// --- Mock transaction state (configurable per test) ---
interface MockTxState {
  totalsRows: Array<Record<string, unknown>>
  roleRows: Array<Record<string, unknown>>
}

let txState: MockTxState

function resetTxState(): void {
  txState = {
    totalsRows: [
      {
        soffice_id: 's-a',
        soffice_name: 'Branch A',
        total_visits: '40',
        total_revenue: '8000',
        orders_from_visits: '10',
      },
      {
        soffice_id: 's-b',
        soffice_name: 'Branch B',
        total_visits: '25',
        total_revenue: '3000',
        orders_from_visits: '5',
      },
    ],
    roleRows: [
      { soffice_id: 's-a', role_label: 'SALESMAN', total_visits: '30', effective_calls: '9' },
      { soffice_id: 's-a', role_label: 'MR', total_visits: '10', effective_calls: '1' },
      { soffice_id: 's-b', role_label: 'SALESMAN', total_visits: '25', effective_calls: '5' },
    ],
  }
}

resetTxState()

/**
 * `getBranchPerformance` issues exactly two raw SQL queries via `tx.execute`
 * in parallel: the branch totals, then the per-role territory aggregation.
 * The order of resolution is deterministic in this mock via call counting.
 */
function buildMockTx() {
  let call = 0
  return {
    execute: () => {
      call += 1
      return Promise.resolve(call === 1 ? txState.totalsRows : txState.roleRows)
    },
  }
}

let withRLSCalls = 0

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    withRLSCalls += 1
    return cb(buildMockTx())
  },
}))

// --- Mock Redis so caching degrades to always-compute in this suite ---
mock.module('../../../config/redis', () => ({
  redis: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
  },
}))

const { getBranchPerformance } = await import('../service')

const ctx = { companyId: 'company-1', userId: 'user-1', userRole: 'ADMIN_CABANG' }

describe('report/service — getBranchPerformance', () => {
  beforeEach(() => {
    resetTxState()
    withRLSCalls = 0
  })

  it('should return a ranked matrix ordered by revenue', async () => {
    const result = await getBranchPerformance({ month: 6, year: 2025 }, ctx)

    expect(result.data.map((r) => r.soffice_id)).toEqual(['s-a', 's-b'])
    expect(result.data[0]!.rank).toBe(1)
    expect(result.data[1]!.rank).toBe(2)
    expect(result.meta).toEqual({ month: 6, year: 2025, total_branches: 2 })
  })

  it('should segment each branch by SALESMAN and MR', async () => {
    const result = await getBranchPerformance({ month: 6, year: 2025 }, ctx)

    const branchA = result.data.find((r) => r.soffice_id === 's-a')!
    expect(branchA.SALESMAN).toEqual({ total_visits: 30, effective_calls: 9, call_rate_pct: 30 })
    expect(branchA.MR).toEqual({ total_visits: 10, effective_calls: 1, call_rate_pct: 10 })

    const branchB = result.data.find((r) => r.soffice_id === 's-b')!
    expect(branchB.MR).toEqual({ total_visits: 0, effective_calls: 0, call_rate_pct: 0 })
  })

  it('should compute branch-level strike rate from orders and visits', async () => {
    const result = await getBranchPerformance({ month: 6, year: 2025 }, ctx)

    const branchA = result.data.find((r) => r.soffice_id === 's-a')!
    expect(branchA.strike_rate_pct).toBe(25) // 10 orders / 40 visits
  })

  it('should run aggregation inside a single RLS-scoped transaction', async () => {
    await getBranchPerformance({ month: 6, year: 2025 }, ctx)
    expect(withRLSCalls).toBe(1)
  })

  it('should return an empty matrix when the views yield no rows', async () => {
    txState.totalsRows = []
    txState.roleRows = []

    const result = await getBranchPerformance({ month: 1, year: 2025 }, ctx)

    expect(result.data).toEqual([])
    expect(result.meta.total_branches).toBe(0)
  })
})
