// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie singleton
// (imported transitively via useOfflineDb) can run under Node. It MUST be imported before any
// module that touches the `db` singleton.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatus, UserRole } from '@maction/types'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'
import { useBackgroundSync, type OutboxDraft, type SyncFetch } from '../useBackgroundSync'

/**
 * Mid-batch network-interruption sync verification (FR-PWA-06).
 *
 * Proves the offline→online outbox drain survives a connection loss that happens PARTWAY
 * THROUGH a flush batch, with zero data loss and no duplicate re-sends:
 *  1. Several mutations are enqueued offline (stay PENDING, FIFO by monotonic `captured_at`).
 *  2. The device goes online and a single `flush()` begins draining the batch.
 *  3. The network drops mid-batch: the first N replays succeed (PENDING → SYNCED), then the
 *     transport starts throwing. The remaining M replays transition PENDING → FAILED with
 *     `retry_count` incremented — they are NOT lost (FAILED is retryable, not terminal).
 *  4. A partial-failure flush leaves connectivity in 'ERROR'
 *     (per flush(): `connectivity.value = failed > 0 ? 'ERROR' : ...`).
 *  5. Once connectivity is restored, a subsequent `flush()` drains only the still-outstanding
 *     FAILED mutations to SYNCED, in FIFO order, without re-sending the already-SYNCED ones.
 *
 * Enqueues go through the real write path (never seed `captured_at` directly) so the actual
 * FIFO ordering guarantee is exercised end-to-end.
 */

const COMPANY_A = 'company-a'
const USER_1 = 'user-1'

/** A role-agnostic (CHECK_IN) draft so the ORDER_SUBMIT role guard never interferes. */
function makeDraft(id: string): OutboxDraft {
  return {
    id,
    company_id: COMPANY_A,
    user_id: USER_1,
    user_role: UserRole.SALESMAN,
    mutation_type: 'CHECK_IN',
    endpoint: '/attendance/check-in',
    http_method: 'POST',
    payload: { seq_id: id },
    mono_delta_ms: 0
  }
}

/** Force `navigator.onLine` for a test; returns a restore fn. */
function setOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: value },
    configurable: true,
    writable: true
  })
  return () => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

describe('useBackgroundSync — mid-batch network interruption (FR-PWA-06)', () => {
  const offline = useOfflineDb()

  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    await Promise.all(db.tables.map(table => table.clear()))
    vi.restoreAllMocks()
  })

  it('syncs the first N, fails the rest with retry_count incremented, and ends in ERROR', async () => {
    // Enqueue offline so nothing flushes eagerly; capture order is the enqueue order.
    const restoreOffline = setOnline(false)
    const enqueueOrder = ['a', 'b', 'c', 'd', 'e']
    const succeedFirst = 2

    const sent: string[] = []
    // Transport succeeds for the first N calls, then the connection "drops" and every
    // subsequent call throws — simulating a network loss partway through the batch.
    const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
      const id = (init.body as { seq_id: string }).seq_id
      if (sent.length >= succeedFirst) {
        throw new Error('network lost')
      }
      sent.push(id)
    })

    const sync = useBackgroundSync({ db: offline, fetcher })
    for (const id of enqueueOrder) {
      await sync.enqueue(makeDraft(id))
    }
    restoreOffline()

    // Go online and drain: first 2 succeed, remaining 3 fail mid-batch.
    const restoreOnline = setOnline(true)
    const result = await sync.flush()

    expect(result).toEqual({ synced: succeedFirst, failed: enqueueOrder.length - succeedFirst })
    // Only the first N mutations were actually transmitted.
    expect(sent).toEqual(enqueueOrder.slice(0, succeedFirst))

    // First N are SYNCED (terminal); the rest are FAILED but retained with retry_count === 1.
    const syncedIds = enqueueOrder.slice(0, succeedFirst)
    const failedIds = enqueueOrder.slice(succeedFirst)
    for (const id of syncedIds) {
      const row = await db.outbox_mutations.get(id)
      expect(row?.sync_status).toBe(SyncStatus.SYNCED)
      expect(row?.synced_at).not.toBeNull()
    }
    for (const id of failedIds) {
      const row = await db.outbox_mutations.get(id)
      expect(row?.sync_status).toBe(SyncStatus.FAILED)
      expect(row?.retry_count).toBe(1)
      expect(row?.error_message).toBe('network lost')
    }

    // No data loss: every failed mutation is still retryable in the backlog.
    const retryable = await offline.listRetryableMutations()
    expect(retryable.map(m => m.id)).toEqual(failedIds)

    // Partial-failure flush leaves the connectivity state machine in ERROR.
    expect(sync.connectivity.value).toBe('ERROR')

    restoreOnline()
  })

  it('recovers the outstanding FAILED mutations on a later flush without re-sending SYNCED ones', async () => {
    const restoreOffline = setOnline(false)
    const enqueueOrder = ['a', 'b', 'c', 'd', 'e']
    const succeedFirst = 2

    // A single mutable transport: throws after the first N calls, then is flipped to fully
    // succeed for the recovery pass. It records every seq_id that reaches the wire so we can
    // assert the already-SYNCED mutations are never re-sent.
    const sent: string[] = []
    let dropNetwork = true
    let firstPassCalls = 0
    const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
      const id = (init.body as { seq_id: string }).seq_id
      if (dropNetwork && firstPassCalls >= succeedFirst) {
        throw new Error('network lost')
      }
      firstPassCalls++
      sent.push(id)
    })

    const sync = useBackgroundSync({ db: offline, fetcher })
    for (const id of enqueueOrder) {
      await sync.enqueue(makeDraft(id))
    }
    restoreOffline()

    // First (interrupted) pass: first 2 succeed, remaining 3 fail.
    const restoreOnline = setOnline(true)
    const first = await sync.flush()
    expect(first).toEqual({ synced: succeedFirst, failed: enqueueOrder.length - succeedFirst })
    expect(sync.connectivity.value).toBe('ERROR')

    const failedIds = enqueueOrder.slice(succeedFirst)
    const sentInFirstPass = [...sent]
    expect(sentInFirstPass).toEqual(enqueueOrder.slice(0, succeedFirst))

    // Connectivity restored: transport now fully succeeds for the retry pass.
    dropNetwork = false
    const second = await sync.flush()

    // All previously-FAILED mutations now sync; nothing left failed.
    expect(second).toEqual({ synced: failedIds.length, failed: 0 })

    // The retry pass drained the outstanding mutations in FIFO order, and ONLY those —
    // the already-SYNCED mutations from the first pass were not re-sent.
    const sentInRetryPass = sent.slice(sentInFirstPass.length)
    expect(sentInRetryPass).toEqual(failedIds)
    // Zero duplicate transport calls for the already-SYNCED mutations.
    const totalSends = sent.filter(id => sentInFirstPass.includes(id)).length
    expect(totalSends).toBe(sentInFirstPass.length)

    // Every mutation is now SYNCED with no residual backlog.
    for (const id of enqueueOrder) {
      const row = await db.outbox_mutations.get(id)
      expect(row?.sync_status).toBe(SyncStatus.SYNCED)
    }
    expect(await offline.listPendingMutations()).toHaveLength(0)
    expect(await offline.listRetryableMutations()).toHaveLength(0)

    // A clean drain settles the state machine out of ERROR.
    expect(sync.connectivity.value).not.toBe('ERROR')

    restoreOnline()
  })
})
