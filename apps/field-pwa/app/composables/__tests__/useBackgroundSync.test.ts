// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie
// singleton (imported transitively via useOfflineDb) can run under Node. It MUST be
// imported before any module that touches the `db` singleton.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatus, UserRole, type LocalOutboxMutation } from '@maction/types'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'
import {
  OUTBOX_SYNC_TAG,
  useBackgroundSync,
  type OutboxDraft,
  type SyncFetch
} from '../useBackgroundSync'

const COMPANY_A = 'company-a'
const USER_1 = 'user-1'

function makeDraft(id: string, role: UserRole = UserRole.SALESMAN): OutboxDraft {
  return {
    id,
    company_id: COMPANY_A,
    user_id: USER_1,
    user_role: role,
    mutation_type: 'ORDER_SUBMIT',
    endpoint: '/orders',
    http_method: 'POST',
    payload: { order_id: id },
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

describe('useBackgroundSync', () => {
  const offline = useOfflineDb()

  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    await Promise.all(db.tables.map(table => table.clear()))
    vi.restoreAllMocks()
  })

  it('enqueues a mutation as PENDING and preserves the capturing user_role', async () => {
    const restore = setOnline(false)
    const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

    await sync.enqueue(makeDraft('m1', UserRole.MR))
    const stored = await db.outbox_mutations.get('m1')

    expect(stored?.sync_status).toBe(SyncStatus.PENDING)
    expect(stored?.user_role).toBe(UserRole.MR)
    expect(stored?.retry_count).toBe(0)
    restore()
  })

  it('does not flush while offline — mutations stay PENDING', async () => {
    const restore = setOnline(false)
    const fetcher = vi.fn<SyncFetch>()
    const sync = useBackgroundSync({ db: offline, fetcher })

    await sync.enqueue(makeDraft('m1'))
    const result = await sync.flush()

    expect(fetcher).not.toHaveBeenCalled()
    expect(result).toEqual({ synced: 0, failed: 0 })
    expect(sync.connectivity.value).toBe('OFFLINE')
    restore()
  })

  it('drains pending mutations in FIFO (captured_at) order when online', async () => {
    const restore = setOnline(true)
    const order: string[] = []
    const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
      order.push((init.body as { order_id: string }).order_id)
    })
    const sync = useBackgroundSync({ db: offline, fetcher })

    // Insert out of order; enqueue timestamps are monotonic so IDs map to FIFO.
    await offline.enqueueMutation(mutationRow('m2', '2024-05-01T10:00:00Z'))
    await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
    await offline.enqueueMutation(mutationRow('m3', '2024-05-01T11:00:00Z'))

    await sync.flush()

    expect(order).toEqual(['m1', 'm2', 'm3'])
    restore()
  })

  it('transitions sync_status PENDING → SYNCED on success', async () => {
    const restore = setOnline(true)
    const fetcher: SyncFetch = vi.fn(async () => ({}))
    const sync = useBackgroundSync({ db: offline, fetcher })

    await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
    const result = await sync.flush()

    const stored = await db.outbox_mutations.get('m1')
    expect(stored?.sync_status).toBe(SyncStatus.SYNCED)
    expect(stored?.synced_at).not.toBeNull()
    expect(result).toEqual({ synced: 1, failed: 0 })
    expect(sync.connectivity.value).toBe('ONLINE')
    restore()
  })

  it('transitions sync_status PENDING → FAILED and records the error on failure', async () => {
    const restore = setOnline(true)
    const fetcher: SyncFetch = vi.fn(async () => {
      throw new Error('server 500')
    })
    const sync = useBackgroundSync({ db: offline, fetcher })

    await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
    const result = await sync.flush()

    const stored = await db.outbox_mutations.get('m1')
    expect(stored?.sync_status).toBe(SyncStatus.FAILED)
    expect(stored?.error_message).toBe('server 500')
    expect(stored?.retry_count).toBe(1)
    expect(result).toEqual({ synced: 0, failed: 1 })
    expect(sync.connectivity.value).toBe('ERROR')
    restore()
  })

  it('preserves user_role through a successful sync', async () => {
    const restore = setOnline(true)
    const seen: UserRole[] = []
    const fetcher: SyncFetch = vi.fn(async () => {})
    const sync = useBackgroundSync({ db: offline, fetcher })

    await offline.enqueueMutation({ ...mutationRow('m1', '2024-05-01T09:00:00Z'), user_role: UserRole.MR })
    await sync.flush()

    const stored = await db.outbox_mutations.get('m1')
    seen.push(stored!.user_role)
    expect(seen).toEqual([UserRole.MR])
    restore()
  })

  it('reports the pending backlog count', async () => {
    const restore = setOnline(false)
    const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

    await sync.enqueue(makeDraft('m1'))
    await sync.enqueue(makeDraft('m2'))
    await sync.refreshPendingCount()

    expect(sync.pendingCount.value).toBe(2)
    restore()
  })

  it('falls back to an eager flush when the Service Worker sync API is unavailable', async () => {
    const restore = setOnline(true)
    const fetcher: SyncFetch = vi.fn(async () => {})
    const sync = useBackgroundSync({ db: offline, fetcher })

    await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
    await sync.registerBackgroundSync()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(OUTBOX_SYNC_TAG).toBe('maction-outbox-sync')
    restore()
  })
})

/** Build a full outbox row for direct DB seeding (bypasses enqueue timestamping). */
function mutationRow(id: string, capturedAt: string): LocalOutboxMutation {
  return {
    id,
    company_id: COMPANY_A,
    user_id: USER_1,
    user_role: UserRole.SALESMAN,
    mutation_type: 'ORDER_SUBMIT',
    endpoint: '/orders',
    http_method: 'POST',
    payload: { order_id: id },
    sync_status: SyncStatus.PENDING,
    captured_at: capturedAt,
    mono_delta_ms: 0,
    synced_at: null,
    error_message: null,
    retry_count: 0
  }
}
