/**
 * `useReporting` — report data fetching + client-side caching for the Web Portal (admin, SSR).
 *
 * The single abstraction admin dashboard/report pages use to read the backend `/reports/*`
 * endpoints (see services/api-server/src/modules/report/routes.ts). It owns:
 *  - Typed fetch methods, one per report endpoint (dashboard KPI, branch performance,
 *    call rate, fraud incidents, order register), each taking a typed query object and
 *    returning the typed response envelope.
 *  - A cache-aside layer keyed by `endpoint + serialized query`, backed by an SSR-safe
 *    state factory (Nuxt `useState`, degrading to a local `ref` off-Nuxt) so a value
 *    fetched during SSR is reused on the client without a second round-trip. Each entry
 *    carries a timestamp and is honored only while fresh (configurable TTL, default 5 min,
 *    aligning with the backend dashboard cache TTL 5–15 min per tech.md). A `force` option
 *    bypasses the cache, and {@link UseReportingApi.clearCache} evicts entries.
 *  - Reactive `isLoading` / `error` refs so pages can render spinners and error banners
 *    without try/catch at every call site.
 *  - An export helper that builds the `/reports/export/:type` URL and (client-only) triggers
 *    a browser download. Binary exports are never cached.
 *
 * Testability mirrors the sibling composables (useApiClient, useTenant): everything external
 * is injectable via an options object (API client, client options, state factory, a clock,
 * a base URL for exports), and nothing throws outside a Nuxt runtime — off-Nuxt it degrades
 * to a local `ref` and a no-op download.
 */
import { ref, type Ref } from 'vue'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

/** Nuxt state key backing the shared report cache (reused across pages/renders). */
export const REPORTING_CACHE_STATE_KEY = 'maction:web-portal:reporting-cache'

/** Default cache TTL (5 minutes) — the low end of the backend dashboard cache window. */
export const DEFAULT_REPORTING_TTL_MS = 5 * 60 * 1000

// --- Query shapes (mirror services/api-server/src/modules/report/schemas.ts) ---

/** `GET /reports/dashboard-kpi` query params. */
export interface DashboardKpiQuery {
  soffice_id?: string
  period?: 'today' | 'week' | 'month'
}

/** `GET /reports/branch-performance` query params. */
export interface BranchPerformanceQuery {
  month: number
  year: number
}

/** `GET /reports/call-rate` query params. */
export interface CallRateQuery {
  month: number
  year: number
  user_id?: string
  soffice_id?: string
  role?: 'SALESMAN' | 'MR'
}

/** Order status literals for the register filter. */
export type OrderRegisterStatus
  = | 'DRAFT'
    | 'SUBMITTED'
    | 'SYNCED_ERP'
    | 'REJECTED_ERP'
    | 'CANCELLED'

/** `GET /reports/orders` query params. */
export interface OrderRegisterQuery {
  page?: number
  limit?: number
  user_id?: string
  soffice_id?: string
  customer_id?: string
  status?: OrderRegisterStatus
  lini_id?: string
  date_from?: string
  date_to?: string
  min_total?: number
  max_total?: number
}

/** Fraud telemetry incident types. */
export type FraudType = 'MOCK_LOCATION' | 'VELOCITY_ANOMALY' | 'ACCURACY_EXCESS' | 'CLOCK_DRIFT'

/** `GET /reports/fraud-incidents` query params. */
export interface FraudIncidentQuery {
  page?: number
  limit?: number
  user_id?: string
  fraud_type?: FraudType
  date_from?: string
  date_to?: string
}

/** Report identifiers accepted by the export endpoint. */
export type ExportReport
  = | 'dashboard-kpi'
    | 'branch-performance'
    | 'call-rate'
    | 'orders'
    | 'fraud-incidents'

/** `GET /reports/export/:type` params + query. */
export interface ExportOptions {
  type: 'xlsx' | 'pdf'
  report: ExportReport
  month?: number
  year?: number
  soffice_id?: string
}

// --- Response shapes (mirror the backend response schemas) ---

/** Per-role aggregate block reused across KPI and performance reports. */
export interface RoleMetrics {
  total_visits: number
  effective_calls: number
  call_rate_pct: number
}

/** `GET /reports/dashboard-kpi` response. */
export interface DashboardKpiResponse {
  data: {
    period: string
    total_active_users: number
    total_orders: number
    total_revenue: number
    SALESMAN: RoleMetrics
    MR: RoleMetrics
  }
  meta: {
    soffice_id: string | null
    generated_at: string
  }
}

/** Single branch performance matrix row. */
export interface BranchPerformanceRow {
  soffice_id: string
  soffice_name: string
  rank: number
  total_visits: number
  total_revenue: number
  strike_rate_pct: number
  SALESMAN: RoleMetrics
  MR: RoleMetrics
}

/** `GET /reports/branch-performance` response. */
export interface BranchPerformanceResponse {
  data: BranchPerformanceRow[]
  meta: {
    month: number
    year: number
    total_branches: number
  }
}

/** Single call-rate row per user. */
export interface CallRateRow {
  user_id: string
  user_name: string
  role_label: 'SALESMAN' | 'MR'
  soffice_id: string
  total_planned: number
  total_visited: number
  call_rate_pct: number
}

/** `GET /reports/call-rate` response. */
export interface CallRateReportResponse {
  data: CallRateRow[]
  meta: {
    month: number
    year: number
    total_users: number
  }
}

/** Single order register row. */
export interface OrderRegisterRow {
  order_id: string
  order_number: string
  user_id: string
  customer_id: string
  soffice_id: string
  status: string
  total_amount: number
  created_at: string
}

/** `GET /reports/orders` response (paginated). */
export interface OrderRegisterResponse {
  data: OrderRegisterRow[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** Single fraud incident row. */
export interface FraudIncidentRow {
  id: string
  user_id: string
  fraud_type: FraudType
  severity: string
  claimed_lat: number | null
  claimed_lng: number | null
  calculated_speed_kmh: number | null
  action_taken: string
  created_at: string
}

/** `GET /reports/fraud-incidents` response (paginated). */
export interface FraudIncidentResponse {
  data: FraudIncidentRow[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

// --- Caching primitives ---

/** A single cached report entry: the value plus the epoch-ms it was stored at. */
export interface CacheEntry<T> {
  value: T
  storedAt: number
}

/** The backing cache map, keyed by `endpoint + serialized query`. */
export type ReportingCache = Record<string, CacheEntry<unknown>>

/**
 * A minimal SSR-safe state factory. Runtime supplies Nuxt `useState` (shared across the
 * request/render); off-Nuxt (unit tests) it degrades to a local `ref`. Injectable so tests
 * can assert cache behavior without a Nuxt runtime.
 */
export type ReportingStateFactory = <T>(key: string, init: () => T) => Ref<T>

/** Per-call options controlling cache usage. */
export interface FetchOptions {
  /** Bypass the cache and force a fresh fetch, storing the result. Defaults to false. */
  force?: boolean
}

/** Options for {@link useReporting}; all optional so runtime and tests can diverge. */
export interface UseReportingOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
  /** Override the SSR-safe state factory (defaults to Nuxt `useState`, else a local ref). */
  stateFactory?: ReportingStateFactory
  /** Cache freshness window in milliseconds (defaults to {@link DEFAULT_REPORTING_TTL_MS}). */
  ttlMs?: number
  /** Clock source for freshness checks (defaults to `Date.now`); injectable for tests. */
  now?: () => number
  /** Base URL for building export links (defaults to the API client's resolved base). */
  exportBaseUrl?: string
}

/** Public surface returned by {@link useReporting}. */
export interface UseReportingApi {
  /** Whether any fetch is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  /** Fetch the executive dashboard KPI (cached). */
  fetchDashboardKpi: (query?: DashboardKpiQuery, options?: FetchOptions) => Promise<DashboardKpiResponse>
  /** Fetch the branch performance matrix (cached). */
  fetchBranchPerformance: (query: BranchPerformanceQuery, options?: FetchOptions) => Promise<BranchPerformanceResponse>
  /** Fetch the call-rate report (cached). */
  fetchCallRate: (query: CallRateQuery, options?: FetchOptions) => Promise<CallRateReportResponse>
  /** Fetch the fraud incident register (cached). */
  fetchFraudIncidents: (query?: FraudIncidentQuery, options?: FetchOptions) => Promise<FraudIncidentResponse>
  /** Fetch the order/quotation register (cached). */
  fetchOrderRegister: (query?: OrderRegisterQuery, options?: FetchOptions) => Promise<OrderRegisterResponse>
  /** Build the absolute URL for a report export (never cached). */
  buildExportUrl: (options: ExportOptions) => string
  /** Trigger a browser download of a report export (client-only; no-op off-browser). */
  downloadExport: (options: ExportOptions) => void
  /** Evict all cached report responses. */
  clearCache: () => void
}

/**
 * Resolve the SSR-safe state factory: Nuxt `useState` when present (shared across the
 * render), else a local `ref` so unit tests and non-Nuxt contexts still work. Never throws.
 */
function resolveStateFactory(explicit?: ReportingStateFactory): ReportingStateFactory {
  if (explicit) return explicit
  const hook = (globalThis as {
    useState?: <T>(key: string, init: () => T) => Ref<T>
  }).useState
  if (typeof hook === 'function') {
    return <T>(key: string, init: () => T): Ref<T> => {
      try {
        return hook<T>(key, init)
      } catch {
        return ref(init()) as Ref<T>
      }
    }
  }
  return <T>(_key: string, init: () => T): Ref<T> => ref(init()) as Ref<T>
}

/**
 * Read the API base URL from Nuxt runtimeConfig for export links, degrading to a relative
 * `/api` prefix off-Nuxt (mirrors useApiClient's resolution). Never throws.
 */
function resolveExportBaseUrl(explicit?: string): string {
  if (explicit) return explicit
  const hook = (globalThis as {
    useRuntimeConfig?: () => { public?: { apiBase?: string } }
  }).useRuntimeConfig
  try {
    const configured = typeof hook === 'function' ? hook()?.public?.apiBase : undefined
    return typeof configured === 'string' && configured.length > 0 ? configured : '/api'
  } catch {
    return '/api'
  }
}

/** A plain, serializable query bag. The typed per-report queries are structurally this. */
type QueryParams = Record<string, unknown>

/**
 * Serialize a query object into a stable string for cache keys. Keys are sorted and
 * `undefined`/`null` values dropped so equivalent queries collide deterministically.
 */
function serializeQuery(query: QueryParams | undefined): string {
  if (!query) return ''
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
  return entries.map(([key, value]) => `${key}=${String(value)}`).join('&')
}

/** Build a cache key from an endpoint path and its query. */
function buildCacheKey(endpoint: string, query: QueryParams | undefined): string {
  const serialized = serializeQuery(query)
  return serialized.length > 0 ? `${endpoint}?${serialized}` : endpoint
}

/** Join a base URL and a path without duplicating the boundary slash. */
function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useReporting(options: UseReportingOptions = {}): UseReportingApi {
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)
  const state = resolveStateFactory(options.stateFactory)
  const ttlMs = options.ttlMs ?? DEFAULT_REPORTING_TTL_MS
  const now = options.now ?? Date.now
  const exportBaseUrl = resolveExportBaseUrl(
    options.exportBaseUrl ?? options.apiClientOptions?.baseUrl
  )

  const isLoading = ref<boolean>(false)
  const error = ref<ApiError | null>(null)
  const cache = state<ReportingCache>(REPORTING_CACHE_STATE_KEY, () => ({}))

  /** Read a cached entry when present and still fresh; otherwise undefined. */
  function readFresh<T>(key: string): T | undefined {
    const entry = cache.value[key]
    if (!entry) return undefined
    if (now() - entry.storedAt >= ttlMs) return undefined
    return entry.value as T
  }

  /**
   * Cache-aside fetch: return a fresh cached value unless `force` is set, otherwise call the
   * API, store the result, and manage the reactive `isLoading` / `error` refs.
   */
  async function fetchCached<T>(
    endpoint: string,
    query: object | undefined,
    fetchOptions: FetchOptions | undefined
  ): Promise<T> {
    // The typed per-report queries are structurally plain string/number/optional bags,
    // so they serialize and forward as a `QueryParams` record without loss.
    const queryParams = query as QueryParams | undefined
    const key = buildCacheKey(endpoint, queryParams)
    if (!fetchOptions?.force) {
      const hit = readFresh<T>(key)
      if (hit !== undefined) return hit
    }

    isLoading.value = true
    error.value = null
    try {
      const value = await apiClient.get<T>(endpoint, { query: queryParams })
      cache.value = { ...cache.value, [key]: { value, storedAt: now() } }
      return value
    } catch (err) {
      const apiError = toApiError(err)
      error.value = apiError
      throw apiError
    } finally {
      isLoading.value = false
    }
  }

  function fetchDashboardKpi(
    query: DashboardKpiQuery = {},
    fetchOptions?: FetchOptions
  ): Promise<DashboardKpiResponse> {
    return fetchCached<DashboardKpiResponse>('/reports/dashboard-kpi', query, fetchOptions)
  }

  function fetchBranchPerformance(
    query: BranchPerformanceQuery,
    fetchOptions?: FetchOptions
  ): Promise<BranchPerformanceResponse> {
    return fetchCached<BranchPerformanceResponse>('/reports/branch-performance', query, fetchOptions)
  }

  function fetchCallRate(
    query: CallRateQuery,
    fetchOptions?: FetchOptions
  ): Promise<CallRateReportResponse> {
    return fetchCached<CallRateReportResponse>('/reports/call-rate', query, fetchOptions)
  }

  function fetchFraudIncidents(
    query: FraudIncidentQuery = {},
    fetchOptions?: FetchOptions
  ): Promise<FraudIncidentResponse> {
    return fetchCached<FraudIncidentResponse>('/reports/fraud-incidents', query, fetchOptions)
  }

  function fetchOrderRegister(
    query: OrderRegisterQuery = {},
    fetchOptions?: FetchOptions
  ): Promise<OrderRegisterResponse> {
    return fetchCached<OrderRegisterResponse>('/reports/orders', query, fetchOptions)
  }

  /** Build the absolute export URL, encoding the report + calendar scope as query params. */
  function buildExportUrl(exportOptions: ExportOptions): string {
    const { type, ...query } = exportOptions
    const search = serializeQuery(query as unknown as QueryParams)
    const path = `/reports/export/${type}`
    const url = joinUrl(exportBaseUrl, path)
    return search.length > 0 ? `${url}?${search}` : url
  }

  /**
   * Trigger a browser download of a report export. Client-only: off-browser (SSR, unit
   * tests) it degrades to a no-op rather than throwing, mirroring the sibling composables.
   */
  function downloadExport(exportOptions: ExportOptions): void {
    const doc = (globalThis as { document?: Document }).document
    if (!doc || typeof doc.createElement !== 'function') return
    const anchor = doc.createElement('a')
    anchor.href = buildExportUrl(exportOptions)
    anchor.rel = 'noopener'
    anchor.download = ''
    doc.body?.appendChild(anchor)
    anchor.click()
    doc.body?.removeChild(anchor)
  }

  /** Evict all cached report responses. */
  function clearCache(): void {
    cache.value = {}
  }

  return {
    isLoading,
    error,
    fetchDashboardKpi,
    fetchBranchPerformance,
    fetchCallRate,
    fetchFraudIncidents,
    fetchOrderRegister,
    buildExportUrl,
    downloadExport,
    clearCache
  }
}
