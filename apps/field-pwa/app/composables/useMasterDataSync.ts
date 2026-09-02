/**
 * `useMasterDataSync` — hydrate the offline Dexie database with the field user's
 * scoped master data on app launch.
 *
 * The read-path counterpart to {@link useBackgroundSync} (which owns the write path).
 * On launch — and safe to call repeatedly — it pulls the tenant- and lini-scoped master
 * data every offline screen depends on and bulk-upserts it into IndexedDB via
 * {@link useOfflineDb}, keyed by the `[company_id+id]` compound primary key:
 *
 *  - customers   — Outlets (`GET /customers?customer_type=OUTLET`) plus the doctor roster
 *                  (`GET /doctors`), both persisted as unified `master_customer` rows.
 *  - doctors     — doctor profiles + outlet assignments (from the `GET /doctors` roster,
 *                  then per-doctor `GET /doctors/:id` for the profile + assignment sub-resources).
 *  - materials   — SKU catalog (`GET /materials`). Lini scoping is enforced entirely by
 *                  backend RLS from the JWT `lini_ids`; the client never re-filters.
 *  - user-lini   — the field user's own `user_lini_assignments`, synthesized from the
 *                  authenticated profile's `lini_ids` (the admin `GET /users/:id/lini`
 *                  endpoint is not reachable by SALESMAN/MR roles).
 *  - visit_plans — today's MVP/SCP (`GET /call-plans/today`).
 *
 * Guards: it is a no-op when the user is not authenticated or the device is offline —
 * offline launches fall back to whatever is already cached in Dexie. Reactive status
 * refs (`state`, `lastSyncedAt`, `error`) drive the sync-status UI.
 *
 * All network access flows through {@link useApiClient} and all persistence through
 * {@link useOfflineDb}; both are injectable so tests never hit real endpoints or IndexedDB.
 */
import { readonly, ref, type Ref } from 'vue'
import type {
  MasterCustomer,
  DoctorProfile,
  DoctorOutletAssignment,
  MasterMaterial,
  VisitPlan
} from '@maction/types'
import { useApiClient, type ApiClientApi } from './useApiClient'
import { useOfflineDb, type OfflineDbApi } from './useOfflineDb'
import { useAuthStore } from '../stores/useAuthStore'
import type { UserLiniAssignment } from '~~/database'

/** Lifecycle state of the master-data sync, surfaced for the sync-status UI. */
export type MasterSyncState = 'idle' | 'syncing' | 'success' | 'error'

/** Identity + scope the sync needs; sourced from the authenticated JWT profile. */
export interface SyncIdentity {
  company_id: string
  user_id: string
  lini_ids: string[]
}

/** Minimal auth surface consumed by the sync — satisfied by `useAuthStore` or a test fake. */
export interface AuthSource {
  isAuthenticated: boolean
  identity: SyncIdentity | null
}

/** Backend list envelope shared by every paginated master-data endpoint. */
interface ListEnvelope<T> {
  data: T[]
}

/** Doctor roster item — a `master_customer` row (customer_type = DOCTOR) carrying its id. */
type DoctorRosterItem = MasterCustomer & { id: string }

/** Doctor detail envelope — carries the profile + assignment sub-resources. */
interface DoctorDetailEnvelope {
  data: {
    id: string
    company_id?: string
    doctor_profile?: (Partial<DoctorProfile> & { id: string }) | null
    assignments?: Array<Partial<DoctorOutletAssignment> & { id: string }>
  }
}

/** Options for {@link useMasterDataSync}; all optional so runtime and tests can diverge. */
export interface MasterDataSyncOptions {
  /** Override the API client (tests inject a fake; runtime uses `useApiClient`). */
  api?: ApiClientApi
  /** Override the offline DB layer (tests inject a fake; runtime uses `useOfflineDb`). */
  db?: OfflineDbApi
  /** Override the auth source (tests inject a fake; runtime reads `useAuthStore`). */
  auth?: AuthSource
  /** Max concurrent per-doctor detail fetches; bounds the N+1 during large catalogs. */
  doctorFetchConcurrency?: number
}

/** Public surface returned by {@link useMasterDataSync}. */
export interface MasterDataSyncApi {
  state: Readonly<Ref<MasterSyncState>>
  lastSyncedAt: Readonly<Ref<string | null>>
  error: Readonly<Ref<string | null>>
  syncMasterData: () => Promise<MasterSyncState>
}

/** Default number of doctor-detail requests kept in flight at once. */
const DEFAULT_DOCTOR_CONCURRENCY = 5

/** `true` when the browser reports connectivity (or in non-browser contexts like SSR/tests). */
function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

/** Read the current identity + auth flag from the Pinia auth store. */
function readAuthSource(): AuthSource {
  const store = useAuthStore()
  const profile = store.profile
  return {
    isAuthenticated: store.isAuthenticated,
    identity: profile
      ? { company_id: profile.company_id, user_id: profile.user_id, lini_ids: profile.lini_ids }
      : null
  }
}

/**
 * Build the field user's own `user_lini_assignments` rows from the JWT `lini_ids`.
 *
 * Field roles (SALESMAN/MR) cannot call the admin-only `GET /users/:id/lini` endpoint,
 * but the JWT already carries the authoritative scoped `lini_ids`. Synthesizing rows here
 * keeps the offline table populated so lini-scoped material lookups work without a network
 * round-trip. Ids are deterministic (`{user_id}:{lini_id}`) so repeated syncs upsert in place.
 */
function buildLiniAssignments(identity: SyncIdentity, now: string): UserLiniAssignment[] {
  return identity.lini_ids.map(liniId => ({
    id: `${identity.user_id}:${liniId}`,
    company_id: identity.company_id,
    user_id: identity.user_id,
    lini_id: liniId,
    is_active: true,
    created_at: now,
    updated_at: now
  }))
}

/** Map an array with a bounded number of promises in flight to avoid request stampedes. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

export function useMasterDataSync(options: MasterDataSyncOptions = {}): MasterDataSyncApi {
  const api = options.api ?? useApiClient()
  const db = options.db ?? useOfflineDb()
  const doctorConcurrency = options.doctorFetchConcurrency ?? DEFAULT_DOCTOR_CONCURRENCY

  const state = ref<MasterSyncState>('idle')
  const lastSyncedAt = ref<string | null>(null)
  const error = ref<string | null>(null)

  /** Guard against overlapping runs so repeated launch triggers coalesce into one sync. */
  let inFlight: Promise<MasterSyncState> | null = null

  /** Fetch Outlet customers and persist them as `master_customer` rows. */
  async function syncOutlets(): Promise<void> {
    const outlets = await api.get<ListEnvelope<MasterCustomer>>('/customers', {
      query: { customer_type: 'OUTLET' }
    })
    await db.bulkPutCustomers(outlets.data)
  }

  /**
   * Fetch the doctor roster (persisting the doctors as `master_customer` rows), then each
   * doctor's detail to hydrate the `doctor_profiles` and `doctor_outlet_assignments` tables.
   * Detail requests are bounded by concurrency to avoid a request stampede on large catalogs.
   */
  async function syncDoctors(identity: SyncIdentity): Promise<void> {
    const roster = await api.get<ListEnvelope<DoctorRosterItem>>('/doctors')
    await db.bulkPutCustomers(roster.data)

    const details = await mapWithConcurrency(roster.data, doctorConcurrency, doctor =>
      api.get<DoctorDetailEnvelope>(`/doctors/${doctor.id}`)
    )

    const profiles: DoctorProfile[] = []
    const assignments: DoctorOutletAssignment[] = []
    for (const detail of details) {
      const record = detail.data
      const companyId = record.company_id ?? identity.company_id
      if (record.doctor_profile) {
        profiles.push({ ...record.doctor_profile, company_id: companyId } as DoctorProfile)
      }
      for (const assignment of record.assignments ?? []) {
        assignments.push({ ...assignment, company_id: companyId } as DoctorOutletAssignment)
      }
    }

    await Promise.all([
      profiles.length ? db.bulkPutDoctorProfiles(profiles) : Promise.resolve(),
      assignments.length ? db.bulkPutDoctorOutletAssignments(assignments) : Promise.resolve()
    ])
  }

  /** Fetch the lini-scoped material catalog (scoping enforced by backend RLS) and cache it. */
  async function syncMaterials(): Promise<void> {
    const materials = await api.get<ListEnvelope<MasterMaterial>>('/materials')
    await db.bulkPutMaterials(materials.data)
  }

  /** Persist the field user's own lini assignments, synthesized from the JWT scope. */
  async function syncLiniAssignments(identity: SyncIdentity, now: string): Promise<void> {
    await db.bulkPutUserLiniAssignments(buildLiniAssignments(identity, now))
  }

  /** Fetch today's MVP/SCP plan for the logged-in field user and cache it. */
  async function syncVisitPlans(): Promise<void> {
    const plans = await api.get<ListEnvelope<VisitPlan>>('/call-plans/today')
    await db.bulkPutVisitPlans(plans.data)
  }

  /** Run the full master-data sync once; concurrent callers await the same in-flight run. */
  function syncMasterData(): Promise<MasterSyncState> {
    if (inFlight) return inFlight
    inFlight = runSync().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function runSync(): Promise<MasterSyncState> {
    const auth = options.auth ?? readAuthSource()

    // No-op when unauthenticated (e.g. on the login page) or offline — cached data stands in.
    if (!auth.isAuthenticated || !auth.identity) {
      state.value = 'idle'
      return state.value
    }
    if (!isOnline()) {
      state.value = 'idle'
      return state.value
    }

    const identity = auth.identity
    const now = new Date().toISOString()
    state.value = 'syncing'
    error.value = null

    try {
      // Independent fetches run in parallel; each persists into its own Dexie table.
      await Promise.all([
        syncOutlets(),
        syncDoctors(identity),
        syncMaterials(),
        syncLiniAssignments(identity, now),
        syncVisitPlans()
      ])
      lastSyncedAt.value = new Date().toISOString()
      state.value = 'success'
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Master data sync failed.'
      state.value = 'error'
    }
    return state.value
  }

  return {
    state: readonly(state),
    lastSyncedAt: readonly(lastSyncedAt),
    error: readonly(error),
    syncMasterData
  }
}
