import { describe, it, expect, mock, beforeEach } from 'bun:test'

// --- Configurable mock transaction state ---
interface MockTxState {
  pageRows: Array<Record<string, unknown>>
  total: number
}

let txState: MockTxState

function resetTxState(): void {
  txState = {
    pageRows: [
      {
        id: 'f-1',
        userId: 'u-1',
        fraudType: 'VELOCITY_ANOMALY',
        severity: 'HIGH',
        claimedLat: -6.2,
        claimedLng: 106.8,
        calculatedSpeedKmh: 240.5,
        actionTaken: 'BLOCK',
        createdAt: '2025-06-15T08:30:00.000Z',
      },
      {
        id: 'f-2',
        userId: 'u-2',
        fraudType: 'MOCK_LOCATION',
        severity: null,
        claimedLat: null,
        claimedLng: null,
        calculatedSpeedKmh: null,
        actionTaken: null,
        createdAt: '2025-06-14T10:00:00.000Z',
      },
    ],
    total: 2,
  }
}

resetTxState()

/**
 * Chainable Drizzle query-builder mock. The count query terminates at
 * `.where()` (no `.orderBy`), resolving to `[{ total }]`; the page query chains
 * through `.orderBy().limit().offset()`, resolving to the page rows.
 */
function buildMockTx() {
  const builder: Record<string, unknown> = {
    select: () => builder,
    from: () => builder,
    where: () => {
      // Count query resolves here; page query continues chaining.
      const p = Promise.resolve([{ total: txState.total }]) as unknown as Record<string, unknown>
      // Attach chain methods so the page query can continue from `.where()`.
      p.orderBy = () => builder
      return p
    },
    orderBy: () => builder,
    limit: () => builder,
    offset: () => Promise.resolve(txState.pageRows),
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

const { getFraudIncidents } = await import('../service')

const ctx = { companyId: 'company-1', userId: 'admin-1', userRole: 'ADMIN_CABANG' }

describe('report/service — getFraudIncidents', () => {
  beforeEach(() => {
    resetTxState()
    withRLSCalls = 0
  })

  it('should map rows to the response shape and set pagination meta', async () => {
    const result = await getFraudIncidents({ page: 1, limit: 20 }, ctx)

    expect(result.meta).toEqual({ page: 1, limit: 20, total: 2 })
    expect(result.data[0]).toEqual({
      id: 'f-1',
      user_id: 'u-1',
      fraud_type: 'VELOCITY_ANOMALY',
      severity: 'HIGH',
      claimed_lat: -6.2,
      claimed_lng: 106.8,
      calculated_speed_kmh: 240.5,
      action_taken: 'BLOCK',
      created_at: '2025-06-15T08:30:00.000Z',
    })
  })

  it('should coalesce null severity and action_taken to DB defaults', async () => {
    const result = await getFraudIncidents({}, ctx)
    const second = result.data.find((r) => r.id === 'f-2')!
    expect(second.severity).toBe('LOW')
    expect(second.action_taken).toBe('SOFT_REJECT')
  })

  it('should default page to 1 and limit to 20 when omitted', async () => {
    const result = await getFraudIncidents({}, ctx)
    expect(result.meta.page).toBe(1)
    expect(result.meta.limit).toBe(20)
  })

  it('should return an empty page when no incidents match', async () => {
    txState.pageRows = []
    txState.total = 0

    const result = await getFraudIncidents({ fraud_type: 'CLOCK_DRIFT' }, ctx)

    expect(result.data).toEqual([])
    expect(result.meta.total).toBe(0)
  })

  it('should run count and page queries inside a single RLS-scoped transaction', async () => {
    await getFraudIncidents({}, ctx)
    expect(withRLSCalls).toBe(1)
  })
})
