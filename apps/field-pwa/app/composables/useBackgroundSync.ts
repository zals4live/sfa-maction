/**
 * `useBackgroundSync` — outbox queue management + Service Worker Background Sync.
 *
 * Owns the offline write path for the Field PWA:
 *  - Enqueue mutations (with the capturing user's `user_role`) into the Dexie outbox.
 *  - Register a Background Sync tag so the Service Worker replays the queue when the
 *    browser regains connectivity, and also flush eagerly on the `online` event.
 *  - Drain pending mutations in FIFO order, replaying each to its recorded endpoint,
 *    and transition `sync_status` PENDING → SYNCED / FAILED.
 *
 * All persistence is delegated to {@link useOfflineDb} — this composable never touches
 * Dexie directly. Network calls flow through an injectable client so tests never hit
 * real endpoints (a minimal `$fetch` fallback is used at runtime until the dedicated
 * `useApiClient` composable lands in a later task).
 *
 * Conflict resolution: the server timestamp wins. A synced mutation is dropped locally;
 * affected records are expected to be re-fetched by the master-data sync flow, so no
 * client-side merge is attempted here (see the `onConflict` seam below).
 */
import { readonly, ref, type Ref } from 'vue'
import type { ConnectivityState, LocalOutboxMutation, MutationType, UserRole } from '@maction/types'
import { SyncStatus, UserRole as UserRoleEnum } from '@maction/types'
import { useOfflineDb, type OfflineDbApi } from './useOfflineDb'

/** Background Sync tag registered with the Service Worker. */
export const OUTBOX_SYNC_TAG = 'maction-outbox-sync'

/**
 * Outbox mutation types that are role-restricted and the sole role permitted to enqueue them.
 * Order-taking is SALESMAN-exclusive: an `ORDER_SUBMIT` mutation must NEVER originate from an
 * MR (mirrors the backend `403 Forbidden` and the `useCartStore.assertSalesman` UI gate). This
 * is the last-line defense at the single chokepoint every offline write flows through, so a bug
 * or a bypass of the cart-store guard can never persist a forbidden order to the outbox.
 */
const ROLE_RESTRICTED_MUTATIONS: Readonly<Record<string, UserRole>> = {
  ORDER_SUBMIT: UserRoleEnum.SALESMAN
}

/** Thrown when a role attempts to enqueue a mutation it is not permitted to create. */
export class OutboxRoleViolationError extends Error {
  readonly mutationType: MutationType
  readonly userRole: UserRole
  readonly requiredRole: UserRole

  constructor(mutationType: MutationType, userRole: UserRole, requiredRole: UserRole) {
    super(`Role ${userRole} may not enqueue a ${mutationType} mutation (requires ${requiredRole}).`)
    this.name = 'OutboxRoleViolationError'
    this.mutationType = mutationType
    this.userRole = userRole
    this.requiredRole = requiredRole
  }
}

/**
 * Enforce the role/mutation-type invariant BEFORE persistence. Throws
 * {@link OutboxRoleViolationError} for a forbidden pairing (e.g. MR + `ORDER_SUBMIT`) so no
 * mutation is ever written to the outbox for a role that is not allowed to create it.
 */
function assertRoleMayEnqueue(mutationType: MutationType, userRole: UserRole): void {
  const requiredRole = ROLE_RESTRICTED_MUTATIONS[mutationType]
  if (requiredRole && userRole !== requiredRole) {
    throw new OutboxRoleViolationError(mutationType, userRole, requiredRole)
  }
}

/** Number of mutations pulled per drain pass to bound memory during large backlogs. */
const DRAIN_BATCH_SIZE = 25

/**
 * Last `captured_at` epoch-ms issued by {@link nextCapturedAt}. Guarantees a strictly
 * increasing capture timestamp so the FIFO drain (which sorts by `captured_at`) preserves
 * enqueue order even when several mutations are captured within the same millisecond — the
 * normal case during a rapid offline visit (check-in, visit-in, audits, order in quick
 * succession). Without this, same-ms ties break by the random UUID primary key and scramble
 * FIFO replay order, violating FR-PWA-06.
 */
let lastCapturedAtMs = 0

/** Issue a strictly-monotonic ISO-8601 capture timestamp (bumps 1ms on same-ms collisions). */
function nextCapturedAt(): string {
  const wall = Date.now()
  const monotonic = wall > lastCapturedAtMs ? wall : lastCapturedAtMs + 1
  lastCapturedAtMs = monotonic
  return new Date(monotonic).toISOString()
}

/** Minimal transport contract — satisfied by `useApiClient` once it exists, or `$fetch`. */
export type SyncFetch = (
  endpoint: string,
  init: { method: string, body: Record<string, unknown> }
) => Promise<unknown>

/** Fields a caller supplies to enqueue a mutation; queue bookkeeping is filled in here. */
export type OutboxDraft = Pick<
  LocalOutboxMutation,
  'id' | 'company_id' | 'user_id' | 'user_role' | 'mutation_type' | 'endpoint' | 'http_method' | 'payload' | 'mono_delta_ms'
>

/** Options for {@link useBackgroundSync}; all optional so runtime and tests can diverge. */
export interface BackgroundSyncOptions {
  /** Override the offline DB layer (tests inject a fake). */
  db?: OfflineDbApi
  /** Override the network transport (tests inject a mock; runtime falls back to `$fetch`). */
  fetcher?: SyncFetch
}

/** Public surface returned by {@link useBackgroundSync}. */
export interface BackgroundSyncApi {
  connectivity: Readonly<Ref<ConnectivityState>>
  pendingCount: Readonly<Ref<number>>
  enqueue: (draft: OutboxDraft) => Promise<string>
  flush: () => Promise<{ synced: number, failed: number }>
  registerBackgroundSync: () => Promise<void>
  startConnectivityWatch: () => void
  stopConnectivityWatch: () => void
  refreshPendingCount: () => Promise<void>
}

/** Default transport: replay through `$fetch` (ofetch) when no client is injected. */
const defaultFetcher: SyncFetch = (endpoint, init) =>
  // TODO(useApiClient): swap for the centralized API client once that composable exists.
  ($fetch as unknown as SyncFetch)(endpoint, init)

/** Compute the navbar connectivity state from raw online-ness and pending backlog. */
function deriveIdleState(online: boolean, pending: number): ConnectivityState {
  if (!online) return 'OFFLINE'
  return pending > 0 ? 'OFFLINE' : 'ONLINE'
}

export function useBackgroundSync(options: BackgroundSyncOptions = {}): BackgroundSyncApi {
  const db = options.db ?? useOfflineDb()
  const fetcher = options.fetcher ?? defaultFetcher

  const connectivity = ref<ConnectivityState>('ONLINE')
  const pendingCount = ref<number>(0)

  const isOnline = (): boolean =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false

  /**
   * Recompute the pending backlog count. Only recomputes the idle connectivity state;
   * the transient `SYNCING` / `ERROR` states are owned by {@link flush} and left intact.
   */
  async function refreshPendingCount(): Promise<void> {
    // Backlog = every un-synced mutation (PENDING + FAILED). A FAILED mutation is still
    // outstanding work awaiting retry, so it belongs in the badge count and keeps the idle
    // state amber/OFFLINE until it drains.
    const outstanding = await db.listRetryableMutations()
    pendingCount.value = outstanding.length
    const isTransient = connectivity.value === 'SYNCING' || connectivity.value === 'ERROR'
    if (!isTransient) {
      connectivity.value = deriveIdleState(isOnline(), outstanding.length)
    }
  }

  /** Persist a mutation as PENDING, then attempt an eager flush when online. */
  async function enqueue(draft: OutboxDraft): Promise<string> {
    // Role-adaptive gate: reject forbidden pairings (e.g. MR + ORDER_SUBMIT) before any write.
    assertRoleMayEnqueue(draft.mutation_type, draft.user_role)
    const mutation: LocalOutboxMutation = {
      ...draft,
      sync_status: SyncStatus.PENDING,
      captured_at: nextCapturedAt(),
      synced_at: null,
      error_message: null,
      retry_count: 0
    }
    const id = await db.enqueueMutation(mutation)
    await refreshPendingCount()
    if (isOnline()) void flush()
    return id
  }

  /** Replay one mutation to its endpoint; returns the resulting terminal status. */
  async function syncOne(mutation: LocalOutboxMutation): Promise<SyncStatus> {
    try {
      await fetcher(mutation.endpoint, { method: mutation.http_method, body: mutation.payload })
      await db.updateMutationStatus(mutation.id, {
        sync_status: SyncStatus.SYNCED,
        synced_at: new Date().toISOString(),
        error_message: null
      })
      return SyncStatus.SYNCED
    } catch (err) {
      await db.updateMutationStatus(mutation.id, {
        sync_status: SyncStatus.FAILED,
        error_message: err instanceof Error ? err.message : String(err),
        retry_count: mutation.retry_count + 1
      })
      return SyncStatus.FAILED
    }
  }

  /** Drain the outbox FIFO (PENDING + retryable FAILED). No-op while offline. */
  async function flush(): Promise<{ synced: number, failed: number }> {
    if (!isOnline()) {
      await refreshPendingCount()
      return { synced: 0, failed: 0 }
    }
    connectivity.value = 'SYNCING'
    let synced = 0
    let failed = 0
    // Drain PENDING and previously-FAILED mutations so a retry pass recovers failures
    // instead of leaving them stuck; SYNCED is the only terminal state.
    const batch = await db.listRetryableMutations(DRAIN_BATCH_SIZE)
    for (const mutation of batch) {
      const status = await syncOne(mutation)
      if (status === SyncStatus.SYNCED) {
        synced++
      } else {
        failed++
      }
    }
    connectivity.value = failed > 0 ? 'ERROR' : deriveIdleState(isOnline(), 0)
    await refreshPendingCount()
    return { synced, failed }
  }

  /** Register the Background Sync tag; fall back to an eager flush where unsupported. */
  async function registerBackgroundSync(): Promise<void> {
    const swReady = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    if (!swReady) {
      await flush()
      return
    }
    try {
      const registration = await navigator.serviceWorker.ready
      const sync = (registration as unknown as { sync?: { register: (tag: string) => Promise<void> } }).sync
      if (sync) {
        await sync.register(OUTBOX_SYNC_TAG)
      } else {
        await flush()
      }
    } catch {
      await flush()
    }
  }

  function handleOnline(): void {
    void flush()
  }

  function handleOffline(): void {
    void refreshPendingCount()
  }

  function startConnectivityWatch(): void {
    if (typeof window === 'undefined') return
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  }

  function stopConnectivityWatch(): void {
    if (typeof window === 'undefined') return
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }

  return {
    connectivity: readonly(connectivity),
    pendingCount: readonly(pendingCount),
    enqueue,
    flush,
    registerBackgroundSync,
    startConnectivityWatch,
    stopConnectivityWatch,
    refreshPendingCount
  }
}

/** Re-exported so callers can type mutation drafts without importing shared types twice. */
export type { UserRole }
