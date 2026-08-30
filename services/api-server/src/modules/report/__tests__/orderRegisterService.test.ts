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
        orderId: 'o-1',
        orderNumber: 'ORD-20250615-0001',
        userId: 'u-1',
        customerId: 'c-1',
        sofficeId: 's-1',
        status: 'SUBMITTED',
        totalAmount: '1250000.00',
        createdAt: '2025-06-15T08:30:00.000Z',
      },
      {
        orderId: 'o-2',
        orderNumber: 'ORD-20250614-0002',
        userId: 'u-2',
        customerId: 'c-2',
        sofficeId: 's-1',
        status: null,
        totalAmount: null,
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
      const p = Promise.resolve([{ total: txState.total }]) as unknown as Record<string, unknown>
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

const { getOrderRegister } = await import('../service')

const ctx = { companyId: 'company-1', userId: 'admin-1', userRole: 'ADMIN_CABANG' }

describe('report/service — getOrderRegister', () => {
  beforeEach(() => {
    resetTxState()
    withRLSCalls = 0
  })

  it('should map rows to the response shape and set pagination meta', async () => {
    const result = await getOrderRegister({ page: 1, limit: 20 }, ctx)

    expect(result.meta).toEqual({ page: 1, limit: 20, total: 2 })
    expect(result.data[0]).toEqual({
      order_id: 'o-1',
      order_number: 'ORD-20250615-0001',
      user_id: 'u-1',
      customer_id: 'c-1',
      soffice_id: 's-1',
      status: 'SUBMITTED',
      total_amount: 1250000,
      created_at: '2025-06-15T08:30:00.000Z',
    })
  })

  it('should coalesce a null status and total to DB/zero defaults', async () => {
    const result = await getOrderRegister({}, ctx)
    const second = result.data.find((r) => r.order_id === 'o-2')!
    expect(second.status).toBe('DRAFT')
    expect(second.total_amount).toBe(0)
  })

  it('should default page to 1 and limit to 20 when omitted', async () => {
    const result = await getOrderRegister({}, ctx)
    expect(result.meta.page).toBe(1)
    expect(result.meta.limit).toBe(20)
  })

  it('should return an empty page when no orders match', async () => {
    txState.pageRows = []
    txState.total = 0

    const result = await getOrderRegister({ status: 'CANCELLED' }, ctx)

    expect(result.data).toEqual([])
    expect(result.meta.total).toBe(0)
  })

  it('should run count and page queries inside a single RLS-scoped transaction', async () => {
    await getOrderRegister({}, ctx)
    expect(withRLSCalls).toBe(1)
  })
})
