/**
 * `useVisits` — today's visit plan (MVP/SCP) list for the Field PWA (SALESMAN & MR).
 *
 * Loads the current field user's plans for today and projects each into a list row with a
 * derived lifecycle status (PLANNED / IN_PROGRESS / COMPLETED). Both field roles see the same
 * list — order taking is gated later, inside the in-visit workflow, not here.
 *
 * Offline-first: today's plans come from `GET /call-plans/today` when online, falling back to
 * the cached Dexie `visit_plans` table (scoped by `[company_id+user_id+plan_date]`) so the list
 * stays usable with no network. Because the PWA has no local `visits` table, per-plan status is
 * DERIVED from `VisitPlan.is_completed` plus the pending outbox (a queued `VISIT_IN`/`VISIT_OUT`
 * for the plan's customer), via the pure {@link deriveVisitStatus} helper.
 *
 * Identity (`company_id`, `user_id`) is read from {@link useAuthStore}. The API client, offline
 * DB, and clock are injectable so the composable can be driven with mocks in tests.
 */
import { computed, readonly, ref, type Ref } from 'vue'
import type { GeoPoint, LocalOutboxMutation, MasterCustomer, VisitPlan } from '@maction/types'
import { useApiClient, type ApiClientApi } from './useApiClient'
import { useOfflineDb, type OfflineDbApi } from './useOfflineDb'
import { useAuthStore } from '~/stores/useAuthStore'
import {
  deriveVisitStatus,
  toPlanDate,
  type VisitListStatus
} from '~/pages/app/visits/visit-status'

/** A plan projected into a display row with its resolved customer + derived status. */
export interface VisitListItem {
  plan: VisitPlan
  /** Resolved customer name from the offline cache, or a fallback when not yet synced. */
  customerName: string
  /** Customer address for the row subtitle, when known. */
  customerAddress: string | null
  /** Customer coordinates for turn-by-turn navigation, or `null` when not geocoded. */
  customerLocation: GeoPoint | null
  /** Derived lifecycle status for the status badge. */
  status: VisitListStatus
}

/** Backend envelope for `GET /call-plans/today` (`{ data }`). */
interface TodayPlansEnvelope {
  data: VisitPlan[]
}

/** Options for {@link useVisits}; all optional so runtime and tests can diverge. */
export interface UseVisitsOptions {
  /** Override the API client (tests inject a mock; runtime falls back to {@link useApiClient}). */
  api?: ApiClientApi
  /** Override the offline DB layer (tests inject a fake). */
  db?: OfflineDbApi
  /** Injectable clock for the "today" lookup; defaults to the wall clock. */
  now?: () => Date
}

/** Public surface returned by {@link useVisits}. */
export interface UseVisitsApi {
  items: Readonly<Ref<VisitListItem[]>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<string | null>>
  hasPlans: Readonly<Ref<boolean>>
  load: () => Promise<void>
}

export function useVisits(options: UseVisitsOptions = {}): UseVisitsApi {
  const auth = useAuthStore()
  const api = options.api ?? useApiClient()
  const db = options.db ?? useOfflineDb()
  const now = options.now ?? (() => new Date())

  const items = ref<VisitListItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const hasPlans = computed(() => items.value.length > 0)

  /** Fetch today's plans online, falling back to the cached Dexie plans when offline. */
  function fetchTodayPlans(companyId: string, userId: string, planDate: string): Promise<VisitPlan[]> {
    return api
      .get<TodayPlansEnvelope>('/call-plans/today', {
        offlineFallback: async () => ({
          data: await db.listVisitPlansByUserAndDate(companyId, userId, planDate)
        })
      })
      .then(response => response?.data ?? [])
  }

  /** Resolve a plan into a display row, reading the customer name from the offline cache. */
  async function toListItem(
    plan: VisitPlan,
    pending: readonly LocalOutboxMutation[]
  ): Promise<VisitListItem> {
    const customer: MasterCustomer | undefined = await db.getCustomer(plan.company_id, plan.customer_id)
    return {
      plan,
      customerName: customer?.name ?? 'Pelanggan tidak dikenal',
      customerAddress: customer?.address ?? null,
      customerLocation: customer?.location_geom ?? null,
      status: deriveVisitStatus(plan, pending)
    }
  }

  /** Load today's plans + pending outbox, then project them into status-derived rows. */
  async function load(): Promise<void> {
    const companyId = auth.companyId
    const userId = auth.userId
    if (!companyId || !userId) {
      error.value = 'Sesi tidak valid. Silakan masuk kembali.'
      return
    }
    loading.value = true
    error.value = null
    try {
      const planDate = toPlanDate(now())
      const [plans, pending] = await Promise.all([
        fetchTodayPlans(companyId, userId, planDate),
        db.listPendingMutations()
      ])
      items.value = await Promise.all(plans.map(plan => toListItem(plan, pending)))
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Gagal memuat daftar kunjungan.'
    } finally {
      loading.value = false
    }
  }

  return {
    items: readonly(items) as Readonly<Ref<VisitListItem[]>>,
    loading: readonly(loading),
    error: readonly(error),
    hasPlans,
    load
  }
}
