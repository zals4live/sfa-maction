/**
 * `useTracking` — live field-force position fetching + polling for the Web Portal (admin).
 *
 * The single abstraction the `/admin/tracking` page uses to read real-time Salesman & MR
 * positions from the backend (`GET /tracking/live-positions`). The design reserves a
 * WebSocket channel (`tracking:{soffice_id}`) for future push delivery; until that lands,
 * this composable polls the REST snapshot on a fixed interval, which the page can start and
 * stop. It owns:
 *  - A typed fetch of the current position snapshot (each field user's latest fix plus a
 *    chronological breadcrumb trail), taking an optional query (soffice/role filter).
 *  - Interval polling ({@link startPolling} / {@link stopPolling}) that refreshes the
 *    reactive `positions` snapshot, so the map re-renders without the page wiring timers.
 *  - Reactive `positions`, `isLoading`, `error`, and `lastUpdatedAt` refs for the page to
 *    bind spinners, error banners, and a "last updated" caption.
 *
 * Testability mirrors the sibling composables (useApiClient, useReporting): the API client,
 * a clock, and the timer scheduler are all injectable, and nothing throws outside a Nuxt
 * runtime. Binary data never flows through here — positions are small JSON snapshots.
 */
import { ref, type Ref } from 'vue'
import type { UserRole } from '@maction/types'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

/** Default polling cadence (15s) — the top of the dashboard cache window in tech.md. */
export const DEFAULT_TRACKING_POLL_MS = 15_000

/** The two field roles surfaced on the tracking map (admins are never tracked). */
export type FieldRole = UserRole.SALESMAN | UserRole.MR

/** `GET /tracking/live-positions` query params (mirrors the backend schema). */
export interface LivePositionsQuery {
  /** Scope to a single sales office; omit for the admin's full branch scope. */
  soffice_id?: string
  /** Filter to a single field role; omit to include both Salesman & MR. */
  role?: FieldRole
}

/** A single GPS breadcrumb point on a field user's trail. */
export interface TrackingBreadcrumb {
  lat: number
  lng: number
  /** ISO-8601 timestamp of the fix. */
  timestamp: string
}

/** A field user's latest position plus their chronological breadcrumb trail. */
export interface TrackedUser {
  user_id: string
  user_name: string
  role_label: FieldRole
  soffice_id: string
  lat: number
  lng: number
  /** ISO-8601 timestamp of the latest fix. */
  timestamp: string
  /** Ordered trail (oldest → newest) of recent fixes; may be empty. */
  breadcrumbs: TrackingBreadcrumb[]
}

/** `GET /tracking/live-positions` response envelope. */
export interface LivePositionsResponse {
  data: TrackedUser[]
  meta: {
    soffice_id: string | null
    generated_at: string
  }
}

/**
 * A cancellable interval scheduler. Runtime uses the global `setInterval`/`clearInterval`;
 * tests inject a controllable fake. The handle type is opaque so both browser and Node
 * timer return types satisfy it.
 */
export interface IntervalScheduler {
  set: (handler: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/** Options for {@link useTracking}; all optional so runtime and tests can diverge. */
export interface UseTrackingOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
  /** Poll cadence in milliseconds (defaults to {@link DEFAULT_TRACKING_POLL_MS}). */
  pollMs?: number
  /** Clock source for the `lastUpdatedAt` stamp (defaults to `Date.now`). */
  now?: () => number
  /** Interval scheduler (defaults to the global timers; injectable for tests). */
  scheduler?: IntervalScheduler
}

/** Public surface returned by {@link useTracking}. */
export interface UseTrackingApi {
  /** The latest position snapshot; empty until the first successful fetch. */
  positions: Ref<TrackedUser[]>
  /** Whether a fetch is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  /** Epoch-ms of the last successful refresh, or null before the first. */
  lastUpdatedAt: Ref<number | null>
  /** Whether the polling loop is currently active. */
  isPolling: Ref<boolean>
  /** Fetch the current snapshot once, updating `positions`; returns the raw response. */
  fetchPositions: (query?: LivePositionsQuery) => Promise<LivePositionsResponse>
  /** Begin interval polling with the given query; refetches immediately, then every `pollMs`. */
  startPolling: (query?: LivePositionsQuery) => void
  /** Stop the polling loop (safe to call when not polling). */
  stopPolling: () => void
}

/** Default scheduler bound to the global timers; used when none is injected. */
const defaultScheduler: IntervalScheduler = {
  set: (handler, ms) => setInterval(handler, ms),
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useTracking(options: UseTrackingOptions = {}): UseTrackingApi {
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)
  const pollMs = options.pollMs ?? DEFAULT_TRACKING_POLL_MS
  const now = options.now ?? Date.now
  const scheduler = options.scheduler ?? defaultScheduler

  const positions = ref<TrackedUser[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<ApiError | null>(null)
  const lastUpdatedAt = ref<number | null>(null)
  const isPolling = ref<boolean>(false)

  // The active query and timer handle for the polling loop; null when idle.
  let activeQuery: LivePositionsQuery | undefined
  let handle: unknown = null

  /** Fetch the current snapshot once and publish it to `positions`. */
  async function fetchPositions(query: LivePositionsQuery = {}): Promise<LivePositionsResponse> {
    isLoading.value = true
    error.value = null
    try {
      const response = await apiClient.get<LivePositionsResponse>('/tracking/live-positions', {
        // The typed query is structurally a plain string/enum bag; forward it as a record.
        query: query as Record<string, unknown>
      })
      positions.value = response.data
      lastUpdatedAt.value = now()
      return response
    } catch (err) {
      const apiError = toApiError(err)
      error.value = apiError
      throw apiError
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Run one poll tick. Errors are swallowed here (already captured in `error`) so a single
   * transient failure never tears down the interval — the next tick simply retries.
   */
  function tick(): void {
    void fetchPositions(activeQuery).catch(() => {})
  }

  function startPolling(query: LivePositionsQuery = {}): void {
    stopPolling()
    activeQuery = query
    isPolling.value = true
    // Kick off an immediate fetch so the map paints without waiting a full interval.
    tick()
    handle = scheduler.set(tick, pollMs)
  }

  function stopPolling(): void {
    if (handle !== null) {
      scheduler.clear(handle)
      handle = null
    }
    isPolling.value = false
  }

  return {
    positions,
    isLoading,
    error,
    lastUpdatedAt,
    isPolling,
    fetchPositions,
    startPolling,
    stopPolling
  }
}
