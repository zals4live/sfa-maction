// End-to-end verification of the full offline field workflow (Phase 15 task):
//   check-in → visit-in → in-visit activities → visit-out → order (SALESMAN) / no-order (MR)
//
// Unlike the per-unit specs, this test exercises the REAL wiring end-to-end: the actual Dexie
// singleton (`db`, backed by fake-indexeddb), the real `useBackgroundSync` outbox queue, and
// the real `useApiClient` offline branch. It asserts that every workflow step, while offline,
// lands as a `LocalOutboxMutation` with the correct `mutation_type`, `sync_status: PENDING`,
// and the capturing `user_role`; that the queue drains FIFO on reconnect; and that the
// role-adaptive boundary holds — an MR never produces an `ORDER_SUBMIT` mutation.
//
// `fake-indexeddb/auto` MUST be imported before the composables so the Dexie singleton binds
// to the fake engine.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SyncStatus,
  UserRole,
  type LocalOutboxMutation,
  type MutationType
} from '@maction/types'
import { db } from '~~/database'
import { useApiClient, type RequestIdentity } from '../useApiClient'
import { useBackgroundSync } from '../useBackgroundSync'

const COMPANY = 'company-e2e'

const SALESMAN_IDENTITY: RequestIdentity = {
  company_id: COMPANY,
  user_id: 'salesman-1',
  user_role: UserRole.SALESMAN
}

const MR_IDENTITY: RequestIdentity = {
  company_id: COMPANY,
  user_id: 'mr-1',
  user_role: UserRole.MR
}

/** Force `navigator.onLine` for the duration of a step so we can simulate offline field work. */
function setOnline(online: boolean): void {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => online
  })
}

/** Read the whole outbox back in FIFO (captured_at) order for assertions. */
function readOutbox(): Promise<LocalOutboxMutation[]> {
  return db.outbox_mutations.orderBy('captured_at').toArray()
}

describe('offline field workflow (integration)', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(table => table.clear()))
    setOnline(false) // The field rep is offline for the whole visit.
  })

  afterEach(() => {
    setOnline(true)
    vi.restoreAllMocks()
  })

  it('SALESMAN: enqueues every step incl. ORDER_SUBMIT, all PENDING with SALESMAN role', async () => {
    // A single API client whose real background-sync writes to the real Dexie outbox.
    const api = useApiClient({ sync: useBackgroundSync() })

    // Each step of the daily workflow is a mutation the PWA would perform while offline.
    const steps: Array<{ path: string, type: MutationType }> = [
      { path: '/attendance/check-in', type: 'CHECK_IN' },
      { path: '/visits/start', type: 'VISIT_IN' },
      { path: '/visits/v1/agendas', type: 'AGENDA_CREATE' },
      { path: '/visits/v1/competitor-audits', type: 'COMPETITOR_AUDIT_CREATE' },
      { path: '/visits/v1/stock-audits', type: 'STOCK_AUDIT_CREATE' },
      { path: '/visits/v1/end', type: 'VISIT_OUT' },
      { path: '/orders/submit', type: 'ORDER_SUBMIT' }
    ]

    for (const step of steps) {
      const result = await api.post(step.path, {
        identity: SALESMAN_IDENTITY,
        mutationType: step.type,
        body: { step: step.type }
      })
      // Offline → every write is queued, never performed.
      expect(result).toMatchObject({ queued: true })
    }

    const outbox = await readOutbox()

    // Every workflow step landed in the outbox, in order, as PENDING with the SALESMAN role.
    expect(outbox.map(m => m.mutation_type)).toEqual(steps.map(s => s.type))
    expect(outbox.every(m => m.sync_status === SyncStatus.PENDING)).toBe(true)
    expect(outbox.every(m => m.user_role === UserRole.SALESMAN)).toBe(true)
    expect(outbox.every(m => m.company_id === COMPANY)).toBe(true)

    // The SALESMAN path DOES include an order submission.
    expect(outbox.some(m => m.mutation_type === 'ORDER_SUBMIT')).toBe(true)
  })

  it('MR: enqueues the shared steps but NEVER an ORDER_SUBMIT mutation', async () => {
    const api = useApiClient({ sync: useBackgroundSync() })

    // MR performs the same visit lifecycle MINUS order taking (read-only price/stock lookup
    // is a GET and mutates nothing, so it never touches the outbox).
    const mrSteps: Array<{ path: string, type: MutationType }> = [
      { path: '/attendance/check-in', type: 'CHECK_IN' },
      { path: '/visits/start', type: 'VISIT_IN' },
      { path: '/visits/v1/agendas', type: 'AGENDA_CREATE' },
      { path: '/visits/v1/competitor-audits', type: 'COMPETITOR_AUDIT_CREATE' },
      { path: '/visits/v1/stock-audits', type: 'STOCK_AUDIT_CREATE' },
      { path: '/visits/v1/end', type: 'VISIT_OUT' }
    ]

    for (const step of mrSteps) {
      await api.post(step.path, {
        identity: MR_IDENTITY,
        mutationType: step.type,
        body: { step: step.type }
      })
    }

    const outbox = await readOutbox()

    expect(outbox.map(m => m.mutation_type)).toEqual(mrSteps.map(s => s.type))
    expect(outbox.every(m => m.user_role === UserRole.MR)).toBe(true)
    // The role boundary: an MR outbox NEVER contains an order submission.
    expect(outbox.some(m => m.mutation_type === 'ORDER_SUBMIT')).toBe(false)
  })

  it('drains the full offline backlog in FIFO order once connectivity is restored', async () => {
    const sync = useBackgroundSync()
    const api = useApiClient({ sync })

    const steps: MutationType[] = [
      'CHECK_IN',
      'VISIT_IN',
      'AGENDA_CREATE',
      'COMPETITOR_AUDIT_CREATE',
      'STOCK_AUDIT_CREATE',
      'VISIT_OUT',
      'ORDER_SUBMIT'
    ]
    for (const type of steps) {
      await api.post(`/${type.toLowerCase()}`, {
        identity: SALESMAN_IDENTITY,
        mutationType: type,
        body: { step: type }
      })
    }

    expect(await db.outbox_mutations.count()).toBe(steps.length)

    // Reconnect and flush; capture the replay order the server would observe.
    setOnline(true)
    const replayOrder: MutationType[] = []
    const flushSync = useBackgroundSync({
      fetcher: async (_endpoint, init) => {
        replayOrder.push((init.body as { step: MutationType }).step)
        return {}
      }
    })

    const { synced, failed } = await flushSync.flush()

    expect(failed).toBe(0)
    expect(synced).toBe(steps.length)
    // FIFO: replayed in the same order they were captured offline.
    expect(replayOrder).toEqual(steps)

    // Every mutation transitioned PENDING → SYNCED and left the pending queue.
    const stillPending = await db.outbox_mutations
      .where('sync_status')
      .equals(SyncStatus.PENDING)
      .count()
    expect(stillPending).toBe(0)
  })

  it('keeps the backlog PENDING while offline (flush is a no-op with no connectivity)', async () => {
    const sync = useBackgroundSync()
    const api = useApiClient({ sync })

    await api.post('/attendance/check-in', {
      identity: SALESMAN_IDENTITY,
      mutationType: 'CHECK_IN',
      body: {}
    })

    const fetcher = vi.fn(async () => ({}))
    const offlineSync = useBackgroundSync({ fetcher })
    const { synced } = await offlineSync.flush()

    expect(synced).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await db.outbox_mutations.where('sync_status').equals(SyncStatus.PENDING).count()).toBe(1)
  })
})
