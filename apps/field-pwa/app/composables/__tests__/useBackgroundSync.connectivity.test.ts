// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie singleton
// (imported transitively via useOfflineDb) can run under Node. It MUST be imported before any
// module that touches the `db` singleton.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatus, UserRole, type ConnectivityState, type LocalOutboxMutation } from '@maction/types'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'
import { useBackgroundSync, type SyncFetch } from '../useBackgroundSync'

/**
 * Focused verification of the FR-PWA-07 connectivity state machine that drives the navbar
 * status indicator (`SyncStatusIndicator`). The indicator is a dumb component bound to
 * `useBackgroundSync().connectivity`, so proving the four states (ONLINE / OFFLINE / SYNCING /
 * ERROR) and every transition between them at this source is the meaningful contract.
 *
 * State model (see `useBackgroundSync`):
 *  - Idle states derive from `navigator.onLine` + pending backlog:
 *      offline -> OFFLINE; online & backlog>0 -> OFFLINE; online & backlog==0 -> ONLINE.
 *  - `flush()` owns the transient states: SYNCING on entry (online), then ERROR if any
 *    replay failed, else back to the derived idle state.
 *  - `refreshPendingCount()` never clobbers a transient (SYNCING / ERROR) state.
 */

const COMPANY_A = 'company-a'
const USER_1 = 'user-1'

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

/** Mutate `navigator.onLine` in place without replacing the object (for online/offline events). */
function flipOnline(value: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: value },
    configurable: true,
    writable: true
  })
}

/**
 * Minimal event-emitter `window` (the `node` test environment has no DOM). Records
 * `online` / `offline` listeners and dispatches them synchronously so a test can simulate
 * connectivity changes without a browser. Returns the fake plus a restore fn.
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

describe('useBackgroundSync — connectivity indicator transitions (FR-PWA-07)', () => {
  const offline = useOfflineDb()

  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    await Promise.all(db.tables.map(table => table.clear()))
    vi.restoreAllMocks()
  })

  describe('idle state derivation (ONLINE ↔ OFFLINE)', () => {
    it('starts ONLINE when online with an empty outbox', async () => {
      const restore = setOnline(true)
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn(async () => ({})) })

      await sync.refreshPendingCount()

      expect(sync.connectivity.value).toBe<ConnectivityState>('ONLINE')
      expect(sync.pendingCount.value).toBe(0)
      restore()
    })

    it('reports OFFLINE while the browser is offline', async () => {
      const restore = setOnline(false)
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

      await sync.refreshPendingCount()

      expect(sync.connectivity.value).toBe<ConnectivityState>('OFFLINE')
      restore()
    })

    it('reports OFFLINE (with backlog) when online but mutations are still pending', async () => {
      // Online but with an un-flushed backlog: the indicator stays amber/OFFLINE and the
      // pending count feeds the badge, matching FR-PWA-07 (Offline: amber + pending count).
      const restore = setOnline(true)
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn() })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      await sync.refreshPendingCount()

      expect(sync.connectivity.value).toBe<ConnectivityState>('OFFLINE')
      expect(sync.pendingCount.value).toBe(1)
      restore()
    })
  })

  describe('ONLINE → OFFLINE on the browser `offline` event', () => {
    it('transitions to OFFLINE when connectivity is lost', async () => {
      const restore = setOnline(true)
      const win = installFakeWindow()
      const sync = useBackgroundSync({ db: offline, fetcher: vi.fn(async () => ({})) })
      sync.startConnectivityWatch()

      await sync.refreshPendingCount()
      expect(sync.connectivity.value).toBe<ConnectivityState>('ONLINE')

      flipOnline(false)
      win.dispatch('offline')
      await vi.waitFor(() => {
        expect(sync.connectivity.value).toBe<ConnectivityState>('OFFLINE')
      })

      sync.stopConnectivityWatch()
      win.restore()
      restore()
    })
  })

  describe('OFFLINE → SYNCING → ONLINE on the browser `online` event', () => {
    it('flushes and returns to ONLINE when connectivity is restored', async () => {
      const restoreOffline = setOnline(false)
      const win = installFakeWindow()
      const fetcher: SyncFetch = vi.fn(async () => ({}))
      const sync = useBackgroundSync({ db: offline, fetcher })
      sync.startConnectivityWatch()

      // Enqueue while offline: stays PENDING, indicator OFFLINE.
      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      await sync.refreshPendingCount()
      expect(sync.connectivity.value).toBe<ConnectivityState>('OFFLINE')
      restoreOffline()

      // Reconnect: the `online` event drives a flush that clears the backlog.
      flipOnline(true)
      win.dispatch('online')
      await vi.waitFor(() => {
        expect(sync.connectivity.value).toBe<ConnectivityState>('ONLINE')
      })
      expect(sync.pendingCount.value).toBe(0)
      expect(fetcher).toHaveBeenCalledTimes(1)

      sync.stopConnectivityWatch()
      win.restore()
    })
  })

  describe('SYNCING is entered while a flush is in flight', () => {
    it('holds SYNCING during replay, then settles to ONLINE on success', async () => {
      const restore = setOnline(true)
      let observedDuringFlush: ConnectivityState | undefined
      const sync = useBackgroundSync({
        db: offline,
        // Observe the connectivity state mid-replay, before the flush resolves.
        fetcher: vi.fn(async () => {
          observedDuringFlush = sync.connectivity.value
          return {}
        })
      })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      await sync.flush()

      expect(observedDuringFlush).toBe<ConnectivityState>('SYNCING')
      expect(sync.connectivity.value).toBe<ConnectivityState>('ONLINE')
      restore()
    })
  })

  describe('SYNCING → ERROR on failure, then ERROR → SYNCING → ONLINE on retry', () => {
    it('enters ERROR when a replay fails and recovers on a successful retry', async () => {
      const restore = setOnline(true)
      // Fail the first replay; on the retry, observe the transient state then succeed.
      let attempt = 0
      let observedDuringRetry: ConnectivityState | undefined
      const fetcher: SyncFetch = vi.fn(async () => {
        attempt++
        if (attempt === 1) throw new Error('server 500')
        observedDuringRetry = sync.connectivity.value
        return {}
      })
      const sync = useBackgroundSync({ db: offline, fetcher })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))

      // First attempt fails -> ERROR (red / retry option per FR-PWA-07). The FAILED mutation
      // stays in the backlog so a retry has something to re-attempt.
      const first = await sync.flush()
      expect(first).toEqual({ synced: 0, failed: 1 })
      expect(sync.connectivity.value).toBe<ConnectivityState>('ERROR')
      expect(sync.pendingCount.value).toBe(1)

      // Retry: the next flush re-enters SYNCING, re-attempts the FAILED mutation, then
      // settles to ONLINE once the backlog clears.
      const second = await sync.flush()

      expect(observedDuringRetry).toBe<ConnectivityState>('SYNCING')
      expect(second).toEqual({ synced: 1, failed: 0 })
      expect(sync.connectivity.value).toBe<ConnectivityState>('ONLINE')
      expect(sync.pendingCount.value).toBe(0)
      restore()
    })

    it('does not clobber the ERROR state when the backlog is refreshed', async () => {
      const restore = setOnline(true)
      const sync = useBackgroundSync({
        db: offline,
        fetcher: vi.fn(async () => {
          throw new Error('server 500')
        })
      })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      await sync.flush()
      expect(sync.connectivity.value).toBe<ConnectivityState>('ERROR')

      // A subsequent count refresh (e.g. a re-render) must leave the transient ERROR intact.
      await sync.refreshPendingCount()
      expect(sync.connectivity.value).toBe<ConnectivityState>('ERROR')
      restore()
    })
  })

  describe('SYNCING → OFFLINE when a flush succeeds but a backlog remains', () => {
    it('settles to OFFLINE if the batch cap leaves pending mutations after a successful pass', async () => {
      const restore = setOnline(true)
      const fetcher: SyncFetch = vi.fn(async () => ({}))
      const sync = useBackgroundSync({ db: offline, fetcher })

      // Seed more than the drain batch size (25) so one pass cannot clear the whole queue.
      for (let i = 0; i < 30; i++) {
        const seq = String(i).padStart(2, '0')
        await offline.enqueueMutation(mutationRow(`m${seq}`, `2024-05-01T09:00:${seq}Z`))
      }

      const result = await sync.flush()

      // 25 synced this pass, 5 still PENDING -> online-with-backlog derives to OFFLINE.
      expect(result).toEqual({ synced: 25, failed: 0 })
      expect(sync.pendingCount.value).toBe(5)
      expect(sync.connectivity.value).toBe<ConnectivityState>('OFFLINE')
      restore()
    })
  })

  describe('flush is a no-op while offline (stays OFFLINE)', () => {
    it('does not enter SYNCING or touch the network when offline', async () => {
      const restore = setOnline(false)
      const fetcher = vi.fn<SyncFetch>()
      const sync = useBackgroundSync({ db: offline, fetcher })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      const result = await sync.flush()

      expect(fetcher).not.toHaveBeenCalled()
      expect(result).toEqual({ synced: 0, failed: 0 })
      expect(sync.connectivity.value).toBe<ConnectivityState>('OFFLINE')
      restore()
    })
  })
})
