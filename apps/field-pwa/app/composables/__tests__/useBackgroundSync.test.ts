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
  OutboxRoleViolationError,
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

/**
 * Minimal event-emitter `window` (the `node` test environment has no DOM). Records
 * `online` / `offline` listeners and can dispatch them synchronously so a test can
 * simulate connectivity restore without a browser. Returns the fake plus a restore fn.
 */
function installFakeWindow(): {
  dispatch: (type: 'online' | 'offline') => void
  restore: () => void
} {
  const listeners: Record<string, Set<() => void>> = { online: new Set(), offline: new Set() }
  const fakeWindow = {
    addEventListener: (type: string, cb: () => void) => listeners[type]?.add(cb),
    removeEventListener: (type: string, cb: () => void) => listeners[type]?.delete(cb)
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })
  return {
    dispatch: type => listeners[type]?.forEach(cb => cb()),
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'window', original)
      else delete (globalThis as { window?: unknown }).window
    }
  }
}

/**
 * Install a `navigator` exposing a mock Background Sync `SyncManager` via
 * `serviceWorker.ready.sync.register`. Lets a test assert the outbox sync tag is
 * registered when the platform supports the Background Sync API.
 */
function installSyncManagerNavigator(online: boolean): {
  register: ReturnType<typeof vi.fn>
  restore: () => void
} {
  const register = vi.fn(async () => {})
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: online,
      serviceWorker: { ready: Promise.resolve({ sync: { register } }) }
    },
    configurable: true,
    writable: true
  })
  return {
    register,
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
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

    // Use a role-agnostic mutation (CHECK_IN) so this asserts user_role preservation only —
    // the MR + ORDER_SUBMIT pairing is separately proven to be blocked below.
    await sync.enqueue({ ...makeDraft('m1', UserRole.MR), mutation_type: 'CHECK_IN', endpoint: '/attendance/check-in' })
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

  describe('role-adaptive outbox guard (ORDER_SUBMIT is SALESMAN-exclusive)', () => {
    it('allows a SALESMAN to enqueue an ORDER_SUBMIT mutation', async () => {
      const restore = setOnline(false)
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

      const id = await sync.enqueue(makeDraft('order-1', UserRole.SALESMAN))
      const stored = await db.outbox_mutations.get('order-1')

      expect(id).toBe('order-1')
      expect(stored?.mutation_type).toBe('ORDER_SUBMIT')
      expect(stored?.user_role).toBe(UserRole.SALESMAN)
      expect(stored?.sync_status).toBe(SyncStatus.PENDING)
      restore()
    })

    it('blocks an MR from enqueuing an ORDER_SUBMIT mutation and persists nothing', async () => {
      const restore = setOnline(false)
      const fetcher = vi.fn<SyncFetch>()
      const sync = useBackgroundSync({ db: offline, fetcher })

      await expect(sync.enqueue(makeDraft('order-mr', UserRole.MR)))
        .rejects.toBeInstanceOf(OutboxRoleViolationError)

      expect(await db.outbox_mutations.get('order-mr')).toBeUndefined()
      expect(await db.outbox_mutations.count()).toBe(0)
      expect(fetcher).not.toHaveBeenCalled()
      restore()
    })

    it('surfaces the offending role and required role on the violation error', async () => {
      const restore = setOnline(false)
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

      await sync.enqueue(makeDraft('order-mr', UserRole.MR)).catch((err: unknown) => {
        expect(err).toBeInstanceOf(OutboxRoleViolationError)
        const violation = err as OutboxRoleViolationError
        expect(violation.userRole).toBe(UserRole.MR)
        expect(violation.requiredRole).toBe(UserRole.SALESMAN)
        expect(violation.mutationType).toBe('ORDER_SUBMIT')
      })
      restore()
    })

    it('does not restrict role-agnostic mutations (e.g. CHECK_IN) for an MR', async () => {
      const restore = setOnline(false)
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

      const draft: OutboxDraft = {
        ...makeDraft('checkin-mr', UserRole.MR),
        mutation_type: 'CHECK_IN',
        endpoint: '/attendance/check-in'
      }
      await sync.enqueue(draft)

      expect((await db.outbox_mutations.get('checkin-mr'))?.user_role).toBe(UserRole.MR)
      restore()
    })
  })

  describe('Background Sync trigger on connectivity restore', () => {
    it('flushes the outbox when the browser fires the `online` event', async () => {
      // Start offline: enqueue a mutation that must stay PENDING (no eager flush).
      const restoreOffline = setOnline(false)
      const win = installFakeWindow()
      const fetcher: SyncFetch = vi.fn(async () => ({}))
      const sync = useBackgroundSync({ db: offline, fetcher })
      sync.startConnectivityWatch()

      await sync.enqueue(makeDraft('m1'))
      expect(fetcher).not.toHaveBeenCalled()
      expect((await db.outbox_mutations.get('m1'))?.sync_status).toBe(SyncStatus.PENDING)
      restoreOffline()

      // Connectivity restored: navigator reports online, then the `online` event fires.
      const restoreOnline = setOnline(true)
      win.dispatch('online')
      await vi.waitFor(async () => {
        expect((await db.outbox_mutations.get('m1'))?.sync_status).toBe(SyncStatus.SYNCED)
      })

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(sync.connectivity.value).toBe('ONLINE')
      sync.stopConnectivityWatch()
      restoreOnline()
      win.restore()
    })

    it('stops flushing on `online` after the connectivity watch is torn down', async () => {
      const restoreOnline = setOnline(true)
      const win = installFakeWindow()
      const fetcher: SyncFetch = vi.fn(async () => ({}))
      const sync = useBackgroundSync({ db: offline, fetcher })

      sync.startConnectivityWatch()
      sync.stopConnectivityWatch()

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      win.dispatch('online')

      expect(fetcher).not.toHaveBeenCalled()
      expect((await db.outbox_mutations.get('m1'))?.sync_status).toBe(SyncStatus.PENDING)
      restoreOnline()
      win.restore()
    })

    it('registers the outbox sync tag with the Service Worker when the Background Sync API exists', async () => {
      const nav = installSyncManagerNavigator(true)
      const fetcher: SyncFetch = vi.fn(async () => ({}))
      const sync = useBackgroundSync({ db: offline, fetcher })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      await sync.registerBackgroundSync()

      // The SW replays the queue on the `sync` event, so no eager fetch happens here.
      expect(nav.register).toHaveBeenCalledWith(OUTBOX_SYNC_TAG)
      expect(fetcher).not.toHaveBeenCalled()
      nav.restore()
    })
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
