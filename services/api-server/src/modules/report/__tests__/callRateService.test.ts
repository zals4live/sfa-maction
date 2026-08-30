import { describe, it, expect, mock, beforeEach } from 'bun:test'

import { appUsers } from '../../../db/schema/auth'
import { visitPlans, visits } from '../../../db/schema/visit'

// --- Configurable mock transaction state ---
interface MockTxState {
  userRows: Array<Record<string, unknown>>
  plannedRows: Array<{ userId: string; total: number }>
  visitedRows: Array<{ userId: string; total: number }>
}

let txState: MockTxState

function resetTxState(): void {
  txState = {
    userRows: [
      { id: 'u-1', fullName: 'Alice', roleLabel: 'SALESMAN', sofficeId: 's-a' },
      { id: 'u-2', fullName: 'Bob', roleLabel: 'MR', sofficeId: 's-a' },
      { id: 'u-3', fullName: 'Carol', roleLabel: 'SALESMAN', sofficeId: 's-b' },
    ],
    plannedRows: [
      { userId: 'u-1', total: 10 },
      { userId: 'u-2', total: 8 },
      { userId: 'u-3', total: 4 },
    ],
    visitedRows: [
      { userId: 'u-1', total: 9 },
      { userId: 'u-2', total: 2 },
    ],
  }
}

resetTxState()

/**
 * Chainable Drizzle query-builder mock. `.from(table)` records which table is
 * targeted; the terminal `.where()` (users) or `.groupBy()` (counts) resolves
 * to the matching rows from txState based on that table identity.
 */
function buildMockTx() {
  let target: unknown = null
  const builder: Record<string, unknown> = {
    select: () => builder,
    from: (table: unknown) => {
      target = table
      return builder
    },
    where: () => {
      if (target === appUsers) return Promise.resolve(txState.userRows)
      return builder
    },
    groupBy: () => {
      if (target === visitPlans) return Promise.resolve(txState.plannedRows)
      if (target === visits) return Promise.resolve(txState.visitedRows)
      return Promise.resolve([])
    },
  }
  return builder
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

const { getCallRateReport } = await import('../service')

const ctx = { companyId: 'company-1', userId: 'admin-1', userRole: 'ADMIN_CABANG' }

describe('report/service — getCallRateReport', () => {
  beforeEach(() => {
    resetTxState()
    withRLSCalls = 0
  })

  it('should aggregate planned, visited and call rate per user (tenant-level)', async () => {
    const result = await getCallRateReport({ month: 6, year: 2025 }, ctx)

    expect(result.meta).toEqual({ month: 6, year: 2025, total_users: 3 })
    const alice = result.data.find((r) => r.user_id === 'u-1')!
    expect(alice).toEqual({
      user_id: 'u-1',
      user_name: 'Alice',
      role_label: 'SALESMAN',
      soffice_id: 's-a',
      total_planned: 10,
      total_visited: 9,
      call_rate_pct: 90,
    })
  })

  it('should order rows by call rate descending', async () => {
    const result = await getCallRateReport({ month: 6, year: 2025 }, ctx)
    const rates = result.data.map((r) => r.call_rate_pct)
    expect(rates).toEqual([...rates].sort((a, b) => b - a))
    expect(result.data[0]!.user_id).toBe('u-1') // 90%
  })

  it('should return call_rate_pct = 0 for a user with zero plans', async () => {
    txState.userRows = [{ id: 'u-9', fullName: 'Zed', roleLabel: 'MR', sofficeId: 's-a' }]
    txState.plannedRows = []
    txState.visitedRows = []

    const result = await getCallRateReport({ month: 6, year: 2025 }, ctx)

    expect(result.data).toHaveLength(1)
    expect(result.data[0]!.call_rate_pct).toBe(0)
    expect(result.data[0]!.total_planned).toBe(0)
    expect(result.data[0]!.total_visited).toBe(0)
  })

  it('should include soffice_id on every row and coerce null to empty string', async () => {
    txState.userRows = [{ id: 'u-1', fullName: 'Alice', roleLabel: 'SALESMAN', sofficeId: null }]

    const result = await getCallRateReport({ month: 6, year: 2025 }, ctx)

    expect(result.data[0]!.soffice_id).toBe('')
  })

  it('should support a single-user filter scope', async () => {
    txState.userRows = [{ id: 'u-1', fullName: 'Alice', roleLabel: 'SALESMAN', sofficeId: 's-a' }]

    const result = await getCallRateReport({ month: 6, year: 2025, user_id: 'u-1' }, ctx)

    expect(result.meta.total_users).toBe(1)
    expect(result.data[0]!.user_id).toBe('u-1')
  })

  it('should support a branch-level (soffice) filter scope', async () => {
    txState.userRows = [
      { id: 'u-1', fullName: 'Alice', roleLabel: 'SALESMAN', sofficeId: 's-a' },
      { id: 'u-2', fullName: 'Bob', roleLabel: 'MR', sofficeId: 's-a' },
    ]

    const result = await getCallRateReport({ month: 6, year: 2025, soffice_id: 's-a' }, ctx)

    expect(result.data.every((r) => r.soffice_id === 's-a')).toBe(true)
    expect(result.meta.total_users).toBe(2)
  })

  it('should support a role filter scope', async () => {
    txState.userRows = [{ id: 'u-2', fullName: 'Bob', roleLabel: 'MR', sofficeId: 's-a' }]

    const result = await getCallRateReport({ month: 6, year: 2025, role: 'MR' }, ctx)

    expect(result.data.every((r) => r.role_label === 'MR')).toBe(true)
    expect(result.meta.total_users).toBe(1)
  })

  it('should return an empty report when no field users are in scope', async () => {
    txState.userRows = []

    const result = await getCallRateReport({ month: 3, year: 2025 }, ctx)

    expect(result.data).toEqual([])
    expect(result.meta.total_users).toBe(0)
  })

  it('should run aggregation inside a single RLS-scoped transaction', async () => {
    await getCallRateReport({ month: 6, year: 2025 }, ctx)
    expect(withRLSCalls).toBe(1)
  })
})
