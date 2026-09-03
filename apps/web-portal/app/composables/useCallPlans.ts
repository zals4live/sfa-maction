/**
 * `useCallPlans` — Sales Call Plan (SCP/MVP) reads + bulk upload for the Web Portal (admin, SSR).
 *
 * The single abstraction the `/admin/call-plans` page uses to drive the backend call-plan
 * module (see services/api-server/src/modules/call-plan/routes.ts), which exposes four
 * endpoints under the `/call-plans` prefix, all gated by tenantGuard + role checks:
 *  - `GET  /call-plans`             — paginated plan list, filterable by user / month / year /
 *    approval status (`is_approved`).
 *  - `POST /call-plans/bulk-upload` — ADMIN-only batch create for Salesman & MR plans; returns a
 *    per-row created count and index-keyed error list rather than failing the whole batch.
 *  - `GET  /call-plans/today`       — today's plans for the caller (or an admin-overridden user).
 *  - `GET  /call-plans/analytics`   — ADMIN-only call-rate analytics with a Salesman-vs-MR summary.
 *
 * It mirrors the shape and testing pattern of {@link useLini}: no cache-aside layer (plan and
 * visit data are volatile and staleness would mislead approval decisions), one typed method per
 * endpoint, and reactive `isLoading` / `error` refs so pages render spinners and error banners
 * without a try/catch at every call site. The API client is injectable (tests supply a mock),
 * runtime falls back to {@link useApiClient}, and nothing throws outside a Nuxt runtime.
 *
 * NOTE on "approval": the backend exposes no approval-mutation endpoint. Approval here means
 * reading the `is_approved` flag on each plan and filtering the list by it — no write method.
 */
import { ref, type Ref } from 'vue'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

/** Field-force role labels carried by call plans and analytics rows. */
export type CallPlanRole = 'SALESMAN' | 'MR'

// --- Query shapes (mirror services/api-server/src/modules/call-plan/schemas.ts) ---

/** `GET /call-plans` pagination + filter query params. */
export interface ListCallPlansQuery {
  page?: number
  limit?: number
  /** Filter by a specific field user. */
  user_id?: string
  /** Filter by plan month (1-12). */
  month?: number
  /** Filter by plan year. */
  year?: number
  /** Filter by approval status. */
  is_approved?: boolean
}

/** `GET /call-plans/today` query params (admin may override the user). */
export interface TodayCallPlansQuery {
  user_id?: string
}

/** `GET /call-plans/analytics` query params. */
export interface CallPlanAnalyticsQuery {
  /** Report month (1-12). */
  month: number
  /** Report year. */
  year: number
  user_id?: string
  soffice_id?: string
  /** Restrict the report to a single role. */
  role_filter?: CallPlanRole
}

// --- Request bodies ---

/** A single plan entry within a bulk upload (mirrors BulkPlanItemSchema). */
export interface BulkPlanItem {
  user_id: string
  customer_id: string
  outlet_context_id?: string | null
  /** Planned visit date in `YYYY-MM-DD` form. */
  plan_date: string
}

/** `POST /call-plans/bulk-upload` body (1-500 plan entries). */
export interface BulkUploadInput {
  plans: BulkPlanItem[]
}

// --- Response shapes (mirror the backend response schemas) ---

/** A single call-plan record as returned by the list/today endpoints. */
export interface CallPlanResponse {
  id: string
  company_id: string
  user_id: string
  customer_id: string
  outlet_context_id: string | null
  plan_date: string
  is_lead_from_erp: boolean
  is_approved: boolean
  created_at: string
}

/** `GET /call-plans` paginated envelope. */
export interface CallPlanListResponse {
  data: CallPlanResponse[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** `GET /call-plans/today` envelope (not paginated). */
export interface TodayCallPlansResponse {
  data: CallPlanResponse[]
}

/** A single per-row bulk-upload failure, keyed by input index. */
export interface BulkUploadError {
  index: number
  message: string
}

/** `POST /call-plans/bulk-upload` success envelope. */
export interface BulkUploadResponse {
  data: {
    created: number
    errors: BulkUploadError[]
  }
}

/** A single user's call-rate analytics row. */
export interface CallRateEntry {
  user_id: string
  user_name: string
  role_label: CallPlanRole
  total_planned: number
  total_visited: number
  call_rate_pct: number
}

/** A role-level aggregate call-rate block (Salesman or MR). */
export interface RoleSummary {
  total_planned: number
  total_visited: number
  call_rate_pct: number
}

/** `GET /call-plans/analytics` envelope with a per-role summary. */
export interface CallPlanAnalyticsResponse {
  data: CallRateEntry[]
  summary: {
    SALESMAN: RoleSummary
    MR: RoleSummary
  }
  meta: {
    month: number
    year: number
    total_users: number
  }
}

/** Options for {@link useCallPlans}; all optional so runtime and tests can diverge. */
export interface UseCallPlansOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
}

/** Public surface returned by {@link useCallPlans}. */
export interface UseCallPlansApi {
  /** Whether any request is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  /** Fetch a paginated, filterable list of call plans. */
  listCallPlans: (query?: ListCallPlansQuery) => Promise<CallPlanListResponse>
  /** Batch-create call plans for Salesman & MR users (admin only). */
  bulkUploadCallPlans: (input: BulkUploadInput) => Promise<BulkUploadResponse>
  /** Fetch today's call plans for the caller (or an admin-overridden user). */
  getTodayPlans: (query?: TodayCallPlansQuery) => Promise<TodayCallPlansResponse>
  /** Fetch call-rate analytics with a Salesman-vs-MR summary (admin only). */
  getCallPlanAnalytics: (query: CallPlanAnalyticsQuery) => Promise<CallPlanAnalyticsResponse>
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useCallPlans(options: UseCallPlansOptions = {}): UseCallPlansApi {
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)

  const isLoading = ref<boolean>(false)
  const error = ref<ApiError | null>(null)

  /** Run a request while managing the reactive `isLoading` / `error` refs. */
  async function run<T>(op: () => Promise<T>): Promise<T> {
    isLoading.value = true
    error.value = null
    try {
      return await op()
    } catch (err) {
      const apiError = toApiError(err)
      error.value = apiError
      throw apiError
    } finally {
      isLoading.value = false
    }
  }

  function listCallPlans(query: ListCallPlansQuery = {}): Promise<CallPlanListResponse> {
    return run(() => apiClient.get<CallPlanListResponse>('/call-plans', {
      query: query as Record<string, unknown>
    }))
  }

  function bulkUploadCallPlans(input: BulkUploadInput): Promise<BulkUploadResponse> {
    return run(() => apiClient.post<BulkUploadResponse>('/call-plans/bulk-upload', {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function getTodayPlans(query: TodayCallPlansQuery = {}): Promise<TodayCallPlansResponse> {
    return run(() => apiClient.get<TodayCallPlansResponse>('/call-plans/today', {
      query: query as Record<string, unknown>
    }))
  }

  function getCallPlanAnalytics(
    query: CallPlanAnalyticsQuery
  ): Promise<CallPlanAnalyticsResponse> {
    return run(() => apiClient.get<CallPlanAnalyticsResponse>('/call-plans/analytics', {
      query: query as unknown as Record<string, unknown>
    }))
  }

  return {
    isLoading,
    error,
    listCallPlans,
    bulkUploadCallPlans,
    getTodayPlans,
    getCallPlanAnalytics
  }
}
