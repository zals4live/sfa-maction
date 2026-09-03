// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie
// singleton (reached transitively via useOfflineDb) can run under Node. It MUST be
// imported before any module that touches the `db` singleton.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatus, UserRole, type LocalOutboxMutation, type MasterCustomer } from '@maction/types'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'
import { useBackgroundSync, type SyncFetch } from '../useBackgroundSync'
import { useMasterDataSync, type AuthSource } from '../useMasterDataSync'
import type { ApiClientApi } from '../useApiClient'

/**
 * VERIFICATION: conflict resolution — "server timestamp wins, client re-fetches"
 * (design.md §Offline Sync, step 4 / tasks.md Phase 15).
 *
 * This suite documents the ACTUAL, observed behavior of the offline sync stack against
 * the stated conflict-resolution policy. It is a verification harness, not a fabricated
 * pass: where the policy is NOT implemented, the test asserts the real current behavior
 * and pins the gap so it surfaces if/when the policy is later implemented.
 *
 * Findings encoded below:
 *  - PRESENT:  useMasterDataSync re-hydrates (overwrites) local records via bulkPut, so a
 *              subsequent read returns the SERVER copy — i.e. the re-fetch mechanism exists
 *              as a blanket read-sync.
 *  - MISSING:  useBackgroundSync.syncOne has NO server-timestamp comparison and NO
 *              conflict (HTTP 409) branch. A conflicting sync response is not distinguished
 *              from a generic failure, and nothing triggers a targeted re-fetch of the
 *              affected record. The write path and the read path are not wired together on
 *              conflict.
 */

const COMPANY_A = 'company-a'
const USER_1 = 'user-1'
const CUSTOMER_ID = 'cust-1'

/** Force `navigator.onLine`; returns a restore fn. */
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

/** Build a full outbox row for direct DB seeding. */
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

/** A minimal customer row for the local cache (only fields the test reads matter). */
function customerRow(name: string, updatedAt: string): MasterCustomer {
  return {
    id: CUSTOMER_ID,
    company_id: COMPANY_A,
    name,
    updated_at: updatedAt
  } as unknown as MasterCustomer
}

const AUTH: AuthSource = {
  isAuthenticated: true,
  identity: { company_id: COMPANY_A, user_id: USER_1, lini_ids: [] }
}

/** Fake API client that returns a canned server copy of the customer on re-fetch. */
function fakeApi(serverCustomer: MasterCustomer): ApiClientApi {
  const get = vi.fn(async (path: string) => {
    if (path === '/customers') return { data: [serverCustomer] }
    return { data: [] }
  })
  return { get } as unknown as ApiClientApi
}

describe('conflict resolution — server timestamp wins, client re-fetches', () => {
  const offline = useOfflineDb()

  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    await Promise.all(db.tables.map(table => table.clear()))
    vi.restoreAllMocks()
  })

  describe('(b) client re-fetch overwrites the local copy with the server value', () => {
    it('re-hydration via master-data sync replaces a stale local record with the server copy', async () => {
      const restore = setOnline(true)

      // Local cache holds a STALE copy (older timestamp).
      await offline.bulkPutCustomers([customerRow('LOCAL stale name', '2024-05-01T09:00:00.000Z')])

      // Server holds the AUTHORITATIVE, newer copy.
      const server = customerRow('SERVER authoritative name', '2024-05-01T12:00:00.000Z')
      const sync = useMasterDataSync({ api: fakeApi(server), db: offline, auth: AUTH })

      await sync.syncMasterData()

      // After re-fetch the local copy is overwritten by the server value.
      const stored = await offline.getCustomer(COMPANY_A, CUSTOMER_ID)
      expect(stored?.name).toBe('SERVER authoritative name')
      expect((stored as unknown as { updated_at: string }).updated_at).toBe('2024-05-01T12:00:00.000Z')

      restore()
    })
  })

  describe('(a) GAP: no server-timestamp-wins logic on the outbox write path', () => {
    it('treats a 409 Conflict response as a generic FAILED, with NO conflict branch and NO re-fetch', async () => {
      const restore = setOnline(true)

      // Server rejects the replay because it already has a newer version (409 Conflict).
      const conflict = Object.assign(new Error('409 Conflict'), { status: 409 })
      const fetcher: SyncFetch = vi.fn(async () => {
        throw conflict
      })
      const refetch = vi.fn()
      const sync = useBackgroundSync({ db: offline, fetcher })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      const result = await sync.flush()

      const stored = await db.outbox_mutations.get('m1')

      // OBSERVED (current behavior): a conflict is indistinguishable from any other failure.
      // The mutation lands in FAILED, error carries the raw message, and NOTHING re-fetches
      // the authoritative record. There is no `CONFLICT`/`STALE` terminal status and no
      // onConflict seam wired to the master-data re-fetch.
      expect(stored?.sync_status).toBe(SyncStatus.FAILED)
      expect(stored?.sync_status).not.toBe('CONFLICT')
      expect(stored?.error_message).toBe('409 Conflict')
      expect(result).toEqual({ synced: 0, failed: 1 })
      expect(refetch).not.toHaveBeenCalled()

      restore()
    })

    it('does not compare a server timestamp against the pending mutation before replaying', async () => {
      const restore = setOnline(true)

      // Capture the body the client actually sends. If "server timestamp wins" were
      // implemented, the client would first read the server version and either skip or
      // reconcile; instead it blindly POSTs the pending payload.
      const seenBodies: Array<Record<string, unknown>> = []
      const fetcher: SyncFetch = vi.fn(async (_endpoint, init) => {
        seenBodies.push(init.body)
        return {}
      })
      const sync = useBackgroundSync({ db: offline, fetcher })

      await offline.enqueueMutation(mutationRow('m1', '2024-05-01T09:00:00Z'))
      await sync.flush()

      // OBSERVED: exactly one blind replay of the pending payload; no pre-flight GET,
      // no timestamp comparison, no server value ever consulted on the write path.
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(seenBodies).toEqual([{ order_id: 'm1' }])

      restore()
    })
  })
})
