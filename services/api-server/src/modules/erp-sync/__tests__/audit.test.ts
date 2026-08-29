import { describe, it, expect, beforeEach } from 'bun:test'

import { writeInboundSyncAudit } from '../audit'
import type { InboundSyncType } from '../audit'
import type { ErpSyncResult } from '../schemas'

const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const IDEMPOTENCY_KEY = 'aa0e8400-e29b-41d4-a716-44665544000a'

// -----------------------------------------------------------------------------
// Fake Drizzle transaction that records inserted audit rows. The audit helper
// only issues `tx.insert(...).values(...)`, so the fake needs just that chain.
// -----------------------------------------------------------------------------
let inserted: Array<Record<string, unknown>>

function makeTx(): unknown {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row)
        return Promise.resolve()
      },
    }),
  }
}

function successResult(): ErpSyncResult {
  return {
    data: {
      idempotency_key: IDEMPOTENCY_KEY,
      duplicate: false,
      received: 2,
      created: 1,
      updated: 1,
      failed: 0,
      errors: [],
    },
  }
}

beforeEach(() => {
  inserted = []
})

describe('writeInboundSyncAudit — success row', () => {
  it('records an INBOUND row with the applied envelope as responsePayload', async () => {
    const result = successResult()
    await writeInboundSyncAudit(makeTx() as never, {
      companyId: COMPANY_ID,
      syncType: 'CUSTOMER_SYNC',
      endpointUrl: '/erp/webhook/customers',
      idempotencyKey: IDEMPOTENCY_KEY,
      requestPayload: { idempotency_key: IDEMPOTENCY_KEY, records: [] },
      latencyMs: 42,
      isSuccess: true,
      result,
    })

    expect(inserted).toHaveLength(1)
    const row = inserted[0]!
    expect(row['companyId']).toBe(COMPANY_ID)
    expect(row['syncDirection']).toBe('INBOUND')
    expect(row['syncType']).toBe('CUSTOMER_SYNC')
    expect(row['endpointUrl']).toBe('/erp/webhook/customers')
    expect(row['httpMethod']).toBe('POST')
    expect(row['httpStatusCode']).toBe(200)
    expect(row['latencyMs']).toBe(42)
    expect(row['retryCount']).toBe(0)
    expect(row['idempotencyKey']).toBe(IDEMPOTENCY_KEY)
    expect(row['isSuccess']).toBe(true)
    expect(row['relatedEntity']).toBe('master_customer')
    expect(row['responsePayload']).toEqual(result)
    expect(row['errorCode']).toBeNull()
    expect(row['errorMessage']).toBeNull()
  })

  it('maps each inbound sync type to its related entity table', async () => {
    const cases: Array<[InboundSyncType, string]> = [
      ['CUSTOMER_SYNC', 'master_customer'],
      ['MATERIAL_SYNC', 'master_material'],
      ['PRICE_SYNC', 'master_price'],
      ['STOCK_SYNC', 'stock_inventory_atp'],
      ['PROMOTION_SYNC', 'master_promotions'],
      ['LEAD_SYNC', 'visit_plans'],
    ]

    for (const [syncType, entity] of cases) {
      inserted = []
      await writeInboundSyncAudit(makeTx() as never, {
        companyId: COMPANY_ID,
        syncType,
        endpointUrl: `/erp/webhook/${syncType}`,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestPayload: {},
        latencyMs: 1,
        isSuccess: true,
        result: successResult(),
      })
      expect(inserted[0]?.['relatedEntity']).toBe(entity)
    }
  })
})

describe('writeInboundSyncAudit — failure row', () => {
  it('records isSuccess=false with a structured error code/message and null status', async () => {
    await writeInboundSyncAudit(makeTx() as never, {
      companyId: COMPANY_ID,
      syncType: 'MATERIAL_SYNC',
      endpointUrl: '/erp/webhook/materials',
      idempotencyKey: IDEMPOTENCY_KEY,
      requestPayload: { idempotency_key: IDEMPOTENCY_KEY },
      latencyMs: 7,
      isSuccess: false,
      errorCode: 'MATERIAL_SYNC_FAILED',
      errorMessage: 'Batch could not be applied',
    })

    const row = inserted[0]!
    expect(row['isSuccess']).toBe(false)
    expect(row['httpStatusCode']).toBeNull()
    expect(row['responsePayload']).toBeNull()
    expect(row['errorCode']).toBe('MATERIAL_SYNC_FAILED')
    expect(row['errorMessage']).toBe('Batch could not be applied')
  })
})

describe('writeInboundSyncAudit — idempotency key + payload safety', () => {
  it('persists a null idempotency key without throwing', async () => {
    await writeInboundSyncAudit(makeTx() as never, {
      companyId: COMPANY_ID,
      syncType: 'LEAD_SYNC',
      endpointUrl: '/erp/webhook/leads',
      idempotencyKey: null,
      requestPayload: { records: [] },
      latencyMs: 3,
      isSuccess: true,
      result: successResult(),
    })
    expect(inserted[0]?.['idempotencyKey']).toBeNull()
  })
})
