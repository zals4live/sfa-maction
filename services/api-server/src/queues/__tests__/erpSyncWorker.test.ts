import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import type { Job } from 'bullmq'

import { orders, orderItems } from '../../db/schema/order'
import { companies } from '../../db/schema/tenant'

// --- Mock Redis (isolate connection + idempotency SET NX) ---
// createRedisConnection must return a harmless object (BullMQ Queue/Worker are
// lazy singletons and are never constructed in these tests). `redis.set`
// controls the idempotency claim outcome.
let claimResult: 'OK' | null = 'OK'
const setCalls: Array<unknown[]> = []

mock.module('../../config/redis', () => ({
  redis: {
    set: (...args: unknown[]) => {
      setCalls.push(args)
      return Promise.resolve(claimResult)
    },
  },
  createRedisConnection: () => ({}),
  REDIS_URL: 'redis://localhost:6379',
}))

// --- Mock DB withRLS: invoke callback with a fake tx that records writes ---
interface RecordedUpdate {
  status: string
  values: Record<string, unknown>
}

interface FakeTxState {
  order: Record<string, unknown>
  items: Array<Record<string, unknown>>
  company: Record<string, unknown>
  updates: RecordedUpdate[]
  audits: Array<Record<string, unknown>>
}

let txState: FakeTxState

function makeFakeTx() {
  return {
    select: (_cols: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === companies) return Promise.resolve([txState.company])
          if (table === orders) return Promise.resolve([txState.order])
          if (table === orderItems) return Promise.resolve(txState.items)
          return Promise.resolve([])
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          txState.updates.push({ status: values['orderStatus'] as string, values })
          return Promise.resolve()
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        txState.audits.push(values)
        return Promise.resolve()
      },
    }),
  }
}

// Re-export the real db module, overriding ONLY withRLS. `mock.module` is
// global across the test run, so preserving the other exports keeps sibling
// test files (which import from ../../db) working.
const realDb = await import('../../db')
mock.module('../../db', () => ({
  ...realDb,
  withRLS: async (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(makeFakeTx()),
}))

const {
  buildQuotationPayload,
  processErpOrderSyncJob,
  ERP_SYNC_MAX_ATTEMPTS,
  ERP_SYNC_BACKOFF_DELAY_MS,
  ERP_SYNC_JOB_OPTIONS,
} = await import('../erpSyncWorker')

// --- Fixtures ---
const IDEMPOTENCY_KEY = 'aa0e8400-e29b-41d4-a716-44665544000a'
const COMPANY_ID = '660e8400-e29b-41d4-a716-446655440001'
const ORDER_ID = '770e8400-e29b-41d4-a716-446655440002'

function baseHeader() {
  return {
    orderNumber: 'ORD-20240101-0001',
    orderDate: '2024-01-01',
    customerId: 'cust-1',
    orderStatus: 'SUBMITTED',
    subtotalAmount: '100.00',
    totalDiscountAmount: '10.00',
    taxAmount: '9.90',
    grandTotal: '99.90',
  }
}

function seedTxState(overrides: Partial<FakeTxState> = {}): void {
  txState = {
    order: baseHeader(),
    items: [
      {
        materialId: 'mat-1',
        qty: 5,
        uom: 'BOX',
        unitPrice: '20.00',
        discountAmount: '10.00',
        subtotal: '90.00',
      },
    ],
    company: {
      endpointUrl: 'https://erp.example.test/quotations',
      companyCode: 'KF01',
      authConfig: { access_token: 'secret-token' },
    },
    updates: [],
    audits: [],
    ...overrides,
  }
}

function makeJob(attemptsMade: number, attempts = ERP_SYNC_MAX_ATTEMPTS): Job<never> {
  return {
    id: 'job-1',
    data: { orderId: ORDER_ID, companyId: COMPANY_ID, idempotencyKey: IDEMPOTENCY_KEY },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<never>
}

const realFetch = globalThis.fetch

beforeEach(() => {
  claimResult = 'OK'
  setCalls.length = 0
  seedTxState()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('buildQuotationPayload', () => {
  it('maps header, items, and config into the ERP quotation payload with idempotency_key', () => {
    const payload = buildQuotationPayload(
      baseHeader(),
      [
        {
          material_id: 'mat-1',
          qty: 5,
          uom: 'BOX',
          unit_price: '20.00',
          discount_amount: '10.00',
          subtotal: '90.00',
        },
      ],
      { endpointUrl: 'https://x', companyCode: 'KF01', authConfig: null },
      IDEMPOTENCY_KEY
    )

    expect(payload.idempotency_key).toBe(IDEMPOTENCY_KEY)
    expect(payload.erp_company_code).toBe('KF01')
    expect(payload.order_number).toBe('ORD-20240101-0001')
    expect(payload.grand_total).toBe('99.90')
    expect(payload.lines).toHaveLength(1)
    expect(payload.lines[0]?.material_id).toBe('mat-1')
  })

  it('defaults total_discount_amount to "0" when the header value is null', () => {
    const payload = buildQuotationPayload(
      { ...baseHeader(), totalDiscountAmount: null },
      [],
      { endpointUrl: 'https://x', companyCode: null, authConfig: null },
      IDEMPOTENCY_KEY
    )
    expect(payload.total_discount_amount).toBe('0')
  })
})

describe('processErpOrderSyncJob — success path', () => {
  it('marks the order SYNCED_ERP and logs a successful audit row', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ quotation_number: 'QN-555' }), { status: 200 })
    ) as unknown as typeof fetch

    await processErpOrderSyncJob(makeJob(0))

    const synced = txState.updates.find((u) => u.status === 'SYNCED_ERP')
    expect(synced).toBeDefined()
    expect(synced?.values['erpQuotationNumber']).toBe('QN-555')
    expect(txState.audits).toHaveLength(1)
    expect(txState.audits[0]?.['isSuccess']).toBe(true)
    expect(txState.audits[0]?.['syncDirection']).toBe('OUTBOUND')
    expect(txState.audits[0]?.['relatedRecordId']).toBe(ORDER_ID)
  })
})

describe('processErpOrderSyncJob — failure + retry/backoff', () => {
  it('does NOT mark REJECTED_ERP before the final attempt, but rethrows for retry', async () => {
    globalThis.fetch = mock(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    // attemptsMade=0 with max=5 → not final; should log failure + rethrow, no reject.
    await expect(processErpOrderSyncJob(makeJob(0))).rejects.toThrow()

    expect(txState.updates.find((u) => u.status === 'REJECTED_ERP')).toBeUndefined()
    expect(txState.audits).toHaveLength(1)
    expect(txState.audits[0]?.['isSuccess']).toBe(false)
    expect(txState.audits[0]?.['httpStatusCode']).toBe(500)
  })

  it('marks REJECTED_ERP on the final attempt and stores the error payload', async () => {
    globalThis.fetch = mock(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    // attemptsMade = max-1 → final attempt.
    await expect(processErpOrderSyncJob(makeJob(ERP_SYNC_MAX_ATTEMPTS - 1))).rejects.toThrow()

    const rejected = txState.updates.find((u) => u.status === 'REJECTED_ERP')
    expect(rejected).toBeDefined()
    const errorPayload = rejected?.values['erpErrorPayload'] as Record<string, unknown>
    expect(errorPayload['http_status']).toBe(500)
  })
})

describe('processErpOrderSyncJob — idempotency guard', () => {
  it('skips processing when the idempotency claim is lost on first delivery', async () => {
    claimResult = null // duplicate — claim not won
    globalThis.fetch = mock(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

    await processErpOrderSyncJob(makeJob(0))

    // No ERP call, no audit, no status change.
    expect(txState.updates).toHaveLength(0)
    expect(txState.audits).toHaveLength(0)
  })

  it('still processes a retry (attemptsMade > 0) even when the claim is lost — same job re-owns its key', async () => {
    claimResult = null // key already claimed by this same job's earlier attempt
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ quotation_number: 'QN-777' }), { status: 200 })
    ) as unknown as typeof fetch

    // attemptsMade=1 → a retry. A lost claim MUST NOT short-circuit here,
    // otherwise a retried job would silently never sync.
    await processErpOrderSyncJob(makeJob(1))

    expect(txState.audits).toHaveLength(1)
    expect(txState.updates.find((u) => u.status === 'SYNCED_ERP')).toBeDefined()
  })
})

describe('ERP_SYNC_JOB_OPTIONS — exponential backoff configuration', () => {
  it('bounds attempts to ERP_SYNC_MAX_ATTEMPTS', () => {
    expect(ERP_SYNC_MAX_ATTEMPTS).toBe(5)
    expect(ERP_SYNC_JOB_OPTIONS.attempts).toBe(ERP_SYNC_MAX_ATTEMPTS)
  })

  it('uses an exponential backoff strategy with the configured base delay', () => {
    expect(ERP_SYNC_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: ERP_SYNC_BACKOFF_DELAY_MS,
    })
    expect(ERP_SYNC_BACKOFF_DELAY_MS).toBe(5_000)
  })
})

describe('processErpOrderSyncJob — retryCount audit observability', () => {
  it('records job.attemptsMade as retryCount on a non-final failed attempt', async () => {
    globalThis.fetch = mock(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch

    // attemptsMade=2 → third delivery, not final (max=5).
    await expect(processErpOrderSyncJob(makeJob(2))).rejects.toThrow()

    expect(txState.audits).toHaveLength(1)
    expect(txState.audits[0]?.['retryCount']).toBe(2)
    expect(txState.audits[0]?.['isSuccess']).toBe(false)
    expect(txState.audits[0]?.['bullmqJobId']).toBe('job-1')
  })

  it('records the final attempt number as retryCount when the order is rejected', async () => {
    globalThis.fetch = mock(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    await expect(processErpOrderSyncJob(makeJob(ERP_SYNC_MAX_ATTEMPTS - 1))).rejects.toThrow()

    expect(txState.audits[0]?.['retryCount']).toBe(ERP_SYNC_MAX_ATTEMPTS - 1)
    expect(txState.updates.find((u) => u.status === 'REJECTED_ERP')).toBeDefined()
  })

  it('records retryCount 0 on a first-attempt success', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ quotation_number: 'QN-1' }), { status: 200 })
    ) as unknown as typeof fetch

    await processErpOrderSyncJob(makeJob(0))

    expect(txState.audits[0]?.['retryCount']).toBe(0)
  })
})

// =============================================================================
// Phase 16 — Integration: ERP downtime → BullMQ retry with exponential backoff.
//
// Drives `processErpOrderSyncJob` through the FULL configured attempt sequence
// via a stateful BullMQ-like runner that honors `attempts`, computes the
// exponential backoff delay between retries, and re-owns the job's idempotency
// key on every retry (as the real broker does). A downtime-simulating `fetch`
// mock records the idempotency key + headers sent on each attempt so we can
// assert at-most-once delivery semantics.
//
// Validates: Requirements FR-ERP-02, FR-AUD-03, NFR-SEC-02
// =============================================================================

/** Reproduces BullMQ's exponential backoff: delay * 2^(attemptsMade). */
function expectedBackoffMs(attemptsMade: number): number {
  return ERP_SYNC_BACKOFF_DELAY_MS * 2 ** attemptsMade
}

interface AttemptRecord {
  attemptsMade: number
  idempotencyKey: string | undefined
  jobId: string | undefined
}

interface DowntimeRun {
  attempts: AttemptRecord[]
  backoffDelays: number[]
  finalState: 'failed' | 'completed'
  lastError: unknown
}

/**
 * Runs a job through the retry lifecycle exactly as BullMQ would: invoke the
 * processor, and on a thrown error either schedule the next attempt (recording
 * the backoff delay) or land the job in a terminal `failed` state once
 * `attempts` is exhausted. A completed run stops early. Nothing here talks to a
 * real Redis or a real broker — it is a deterministic in-memory driver.
 */
async function runJobToTerminalState(
  processor: (job: Job<never>) => Promise<void>,
  attempts: number
): Promise<DowntimeRun> {
  const run: DowntimeRun = { attempts: [], backoffDelays: [], finalState: 'completed', lastError: null }

  for (let attemptsMade = 0; attemptsMade < attempts; attemptsMade++) {
    const job = makeJob(attemptsMade, attempts)
    try {
      await processor(job)
      run.finalState = 'completed'
      return run
    } catch (err) {
      run.lastError = err
      const isLast = attemptsMade + 1 >= attempts
      if (isLast) {
        run.finalState = 'failed'
      } else {
        run.backoffDelays.push(expectedBackoffMs(attemptsMade))
      }
    }
  }
  return run
}

describe('processErpOrderSyncJob — ERP downtime retry integration', () => {
  it('retries across every configured attempt on a network-error outage, then lands in a failed dead-state', async () => {
    const seen: string[] = []
    // Simulate total ERP downtime: every request is a network-level failure
    // (fetch rejects), which postToErp normalizes to ERP_REQUEST_FAILED.
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push(headers['idempotency-key'] ?? 'MISSING')
      throw new Error('ECONNREFUSED: ERP gateway unreachable')
    }) as unknown as typeof fetch

    const run = await runJobToTerminalState(processErpOrderSyncJob, ERP_SYNC_MAX_ATTEMPTS)

    // 1. The job was attempted the full configured number of times.
    expect(seen).toHaveLength(ERP_SYNC_MAX_ATTEMPTS)
    expect(txState.audits).toHaveLength(ERP_SYNC_MAX_ATTEMPTS)

    // 5. After exhausting attempts the job is in the failed dead-state, and the
    //    order is marked REJECTED_ERP with the network error reflected.
    expect(run.finalState).toBe('failed')
    const rejected = txState.updates.find((u) => u.status === 'REJECTED_ERP')
    expect(rejected).toBeDefined()
    const errPayload = rejected?.values['erpErrorPayload'] as Record<string, unknown>
    expect(errPayload['error_code']).toBe('ERP_REQUEST_FAILED')
    expect(errPayload['http_status']).toBeNull()
  })

  it('keeps the idempotency key stable across every retry — at-most-once ERP delivery', async () => {
    const seen: string[] = []
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push(headers['idempotency-key'] ?? 'MISSING')
      return new Response('gateway down', { status: 503 })
    }) as unknown as typeof fetch

    await runJobToTerminalState(processErpOrderSyncJob, ERP_SYNC_MAX_ATTEMPTS)

    // 3. Same idempotency key on every single attempt (no rotation on retry).
    expect(seen).toHaveLength(ERP_SYNC_MAX_ATTEMPTS)
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBe(IDEMPOTENCY_KEY)
    // Audit rows all carry the same idempotency key too.
    const auditKeys = new Set(txState.audits.map((a) => a['idempotencyKey']))
    expect(auditKeys.size).toBe(1)
    expect(auditKeys.has(IDEMPOTENCY_KEY)).toBe(true)
  })

  it('follows an exponential backoff schedule between retries', async () => {
    globalThis.fetch = mock(async () => new Response('down', { status: 502 })) as unknown as typeof fetch

    const run = await runJobToTerminalState(processErpOrderSyncJob, ERP_SYNC_MAX_ATTEMPTS)

    // 2. One backoff delay between each pair of attempts (attempts - 1 total),
    //    each doubling from the configured base delay.
    expect(run.backoffDelays).toEqual([
      5_000, // after attempt 0
      10_000, // after attempt 1
      20_000, // after attempt 2
      40_000, // after attempt 3
    ])
    // Config remains an exponential strategy with the expected base delay.
    expect(ERP_SYNC_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: ERP_SYNC_BACKOFF_DELAY_MS,
    })
  })

  it('records every attempt in audit_erp_sync_logs with incrementing retry_count, HTTP status, and latency', async () => {
    globalThis.fetch = mock(async () => new Response('server error', { status: 500 })) as unknown as typeof fetch

    await runJobToTerminalState(processErpOrderSyncJob, ERP_SYNC_MAX_ATTEMPTS)

    // 4. One audit row per attempt, retry_count = 0..max-1, each with the
    //    observed HTTP status and a numeric latency measurement.
    expect(txState.audits).toHaveLength(ERP_SYNC_MAX_ATTEMPTS)
    txState.audits.forEach((audit, idx) => {
      expect(audit['retryCount']).toBe(idx)
      expect(audit['httpStatusCode']).toBe(500)
      expect(audit['isSuccess']).toBe(false)
      expect(audit['syncDirection']).toBe('OUTBOUND')
      expect(typeof audit['latencyMs']).toBe('number')
      expect(audit['latencyMs'] as number).toBeGreaterThanOrEqual(0)
    })
  })

  it('recovers to SYNCED_ERP when the ERP endpoint comes back before attempts are exhausted', async () => {
    let call = 0
    // ERP is down for the first two attempts, then recovers on the third.
    globalThis.fetch = mock(async () => {
      call++
      if (call < 3) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ quotation_number: 'QN-RECOVER' }), { status: 200 })
    }) as unknown as typeof fetch

    const run = await runJobToTerminalState(processErpOrderSyncJob, ERP_SYNC_MAX_ATTEMPTS)

    expect(run.finalState).toBe('completed')
    expect(call).toBe(3)
    // Two failed audits + one success audit; order ends SYNCED_ERP, never rejected.
    expect(txState.audits).toHaveLength(3)
    expect(txState.audits[2]?.['isSuccess']).toBe(true)
    expect(txState.updates.find((u) => u.status === 'SYNCED_ERP')).toBeDefined()
    expect(txState.updates.find((u) => u.status === 'REJECTED_ERP')).toBeUndefined()
  })
})
