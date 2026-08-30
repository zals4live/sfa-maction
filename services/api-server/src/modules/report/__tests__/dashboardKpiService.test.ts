import { describe, it, expect, mock, beforeEach } from 'bun:test'

// --- Mock transaction state (configurable per test) ---
interface MockTxState {
  headlineRows: Array<Record<string, unknown>>
  roleRows: Array<Record<string, unknown>>
}

let txState: MockTxState

function resetTxState(): void {
  txState = {
    headlineRows: [{ total_active_users: 12, total_orders: 30, total_revenue: '150000.50' }],
    roleRows: [
      { role_label: 'SALESMAN', total_visits: '20', effective_calls: '10' },
      { role_label: 'MR', total_visits: '15', effective_calls: '3' },
    ],
  }
}

resetTxState()

/**
 * Builds a mock Drizzle transaction. `getDashboardKpi` issues exactly two raw
 * SQL queries via `tx.execute`: first the branch headline totals, then the
 * per-role territory aggregation. We return them in that call order.
 */
function buildMockTx() {
  let call = 0
  return {
    execute: () => {
      call += 1
      return Promise.resolve(call === 1 ? txState.headlineRows : txState.roleRows)
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

const { getDashboardKpi } = await import('../service')

const ctx = {
  companyId: 'company-1',
  userId: 'user-1',
  userRole: 'ADMIN_CABANG',
}

describe('report/service — getDashboardKpi', () => {
  beforeEach(() => {
    resetTxState()
    withRLSCalls = 0
  })

  it('should assemble segmented KPI from branch totals and role metrics', async () => {
    const result = await getDashboardKpi({ period: 'month' }, ctx)

    expect(result.data.period).toBe('month')
    expect(result.data.total_active_users).toBe(12)
    expect(result.data.total_orders).toBe(30)
    expect(result.data.total_revenue).toBe(150000.5)
    expect(result.data.SALESMAN).toEqual({ total_visits: 20, effective_calls: 10, call_rate_pct: 50 })
    expect(result.data.MR).toEqual({ total_visits: 15, effective_calls: 3, call_rate_pct: 20 })
  })

  it('should run aggregation inside a single RLS-scoped transaction', async () => {
    await getDashboardKpi({ period: 'week' }, ctx)
    expect(withRLSCalls).toBe(1)
  })

  it('should default the period to month and echo soffice filter in meta', async () => {
    const result = await getDashboardKpi({ soffice_id: 'soffice-9' }, ctx)

    expect(result.data.period).toBe('month')
    expect(result.meta.soffice_id).toBe('soffice-9')
    expect(typeof result.meta.generated_at).toBe('string')
  })

  it('should return zeroed metrics when the views yield no rows', async () => {
    txState.headlineRows = []
    txState.roleRows = []

    const result = await getDashboardKpi({ period: 'today' }, ctx)

    expect(result.data.total_active_users).toBe(0)
    expect(result.data.total_orders).toBe(0)
    expect(result.data.total_revenue).toBe(0)
    expect(result.data.SALESMAN).toEqual({ total_visits: 0, effective_calls: 0, call_rate_pct: 0 })
    expect(result.data.MR).toEqual({ total_visits: 0, effective_calls: 0, call_rate_pct: 0 })
  })
})
