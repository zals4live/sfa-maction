// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie
// singleton (imported transitively via useOfflineDb) can run under Node. It MUST be
// imported before any module that touches the `db` singleton.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatus, UserRole, type LocalOutboxMutation } from '@maction/types'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'
import { useBackgroundSync, type OutboxDraft, type SyncFetch } from '../useBackgroundSync'

/**
 * FIFO batch-sync verification (FR-PWA-06).
 *
 * Asserts the outbox drains mutations in the same order they were enqueued. FIFO relies on
 * the strictly-monotonic `captured_at` timestamp assigned by `enqueue` combined with the
 * `[sync_status+captured_at]` compound index that `listPendingMutations` scans ascending —
 * so these tests enqueue through the real write path (never seed `captured_at` directly) to
 * exercise the actual ordering guarantee end-to-end.
 */

const COMPANY_A = 'company-a'
const USER_1 = 'user-1'

/** A role-agnostic (CHECK_IN) draft so the role guard never interferes with ordering assertions. */
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

/** Build a full outbox row for direct DB seeding at a chosen captured_at (mid-sync injection). */
function lateMutation(id: string, capturedAt: string): LocalOutboxMutation {
  return {
    id,
    company_id: COMPANY_A,
    user_id: USER_1,
    user_role: UserRole.SALESMAN,
    mutation_type: 'CHECK_IN',
    endpoint: '/attendance/check-in',
    http_method: 'POST',
    payload: { seq_id: id },
    sync_status: SyncStatus.PENDING,
    captured_at: capturedAt,
    mono_delta_ms: 0,
    synced_at: null,
    error_message: null,
    retry_count: 0
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

describe('useBackgroundSync — FIFO batch drain (FR-PWA-06)', () => {
  const offline = useOfflineDb()

  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    await Promise.all(db.tables.map(table => table.clear()))
    vi.restoreAllMocks()
  })

  it('drains a batch in the exact order the mutations were enqueued', async () => {
    // Enqueue offline so nothing flushes eagerly; capture order is the enqueue order.
    const restore = setOnline(false)
    const sent: string[] = []
    const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
      sent.push((init.body as { seq_id: string }).seq_id)
    })
    const sync = useBackgroundSync({ db: offline, fetcher })

    const enqueueOrder = ['a', 'b', 'c', 'd', 'e']
    for (const id of enqueueOrder) {
      await sync.enqueue(makeDraft(id))
    }
    restore()

    // Go online and drain the whole batch.
    const restoreOnline = setOnline(true)
    const result = await sync.flush()

    expect(sent).toEqual(enqueueOrder)
    expect(result).toEqual({ synced: enqueueOrder.length, failed: 0 })
    restoreOnline()
  })

  it('preserves FIFO even when captured within the same wall-clock millisecond', async () => {
    const restore = setOnline(false)
    const sent: string[] = []
    const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
      sent.push((init.body as { seq_id: string }).seq_id)
    })
    const sync = useBackgroundSync({ db: offline, fetcher })

    // Freeze Date.now so every enqueue lands in the same ms; monotonic bump must keep order.
    const frozen = Date.parse('2024-05-01T09:00:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(frozen)

    const enqueueOrder = ['first', 'second', 'third', 'fourth']
    for (const id of enqueueOrder) {
      await sync.enqueue(makeDraft(id))
    }

    // captured_at must be strictly increasing despite the frozen clock.
    const rows = await db.outbox_mutations.orderBy('captured_at').toArray()
    const capturedAts = rows.map(r => r.captured_at)
    const sortedUnique = [...new Set(capturedAts)].sort()
    expect(capturedAts).toEqual(sortedUnique)
    restore()

    const restoreOnline = setOnline(true)
    await sync.flush()

    expect(sent).toEqual(enqueueOrder)
    restoreOnline()
  })

  it('syncs mutations enqueued mid-sync after the earlier batch (no queue-jumping)', async () => {
    const restore = setOnline(true)
    const sent: string[] = []
    const firstBatch = ['b1', 'b2', 'b3']

    // Mid-sync, a fresh mutation lands in the outbox with a captured_at strictly later than the
    // in-flight batch (as `enqueue` would assign via its monotonic clock). It is written to the
    // DB layer directly so the injection cannot trigger a nested eager flush that would race the
    // batch currently draining — we are verifying drain ORDER, not the enqueue trigger. Because
    // `flush` snapshots its batch up front, `late` is excluded from the first pass and drains next.
    let injected = false
    const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
      const id = (init.body as { seq_id: string }).seq_id
      sent.push(id)
      if (!injected) {
        injected = true
        const maxCapturedAt = (await db.outbox_mutations.orderBy('captured_at').last())?.captured_at
        const lateCapturedAt = new Date(Date.parse(maxCapturedAt ?? new Date().toISOString()) + 1).toISOString()
        await offline.enqueueMutation(lateMutation('late', lateCapturedAt))
      }
    })

    const sync = useBackgroundSync({ db: offline, fetcher })

    // Enqueue the first batch offline so it stays PENDING as one unit (no eager per-item flush).
    const restoreOffline = setOnline(false)
    for (const id of firstBatch) {
      await sync.enqueue(makeDraft(id))
    }
    restoreOffline()

    // First flush snapshots {b1,b2,b3}; `late` is injected during b1's send.
    await sync.flush()
    // Second flush drains the remaining PENDING mutation (`late`).
    await sync.flush()
    restore()

    expect(sent).toEqual([...firstBatch, 'late'])
    // Every mutation ends SYNCED and none was skipped or reordered.
    const remaining = await offline.listPendingMutations()
    expect(remaining).toHaveLength(0)
    const late = await db.outbox_mutations.get('late')
    expect(late?.sync_status).toBe(SyncStatus.SYNCED)
  })
})
