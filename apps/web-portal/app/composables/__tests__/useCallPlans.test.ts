import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  useCallPlans,
  type BulkUploadResponse,
  type CallPlanAnalyticsResponse,
  type CallPlanListResponse,
  type CallPlanResponse,
  type TodayCallPlansResponse
} from '../useCallPlans'

/** Build a single call-plan fixture, overriding fields per test. */
function makePlan(overrides: Partial<CallPlanResponse> = {}): CallPlanResponse {
  return {
    id: 'cp1',
    company_id: 'c1',
    user_id: 'u1',
    customer_id: 'cust1',
    outlet_context_id: null,
    plan_date: '2024-03-05',
    is_lead_from_erp: false,
    is_approved: true,
    created_at: '2024-03-01T00:00:00Z',
    ...overrides
  }
}

/** Build a paginated call-plan list envelope. */
function makeListEnvelope(row: CallPlanResponse = makePlan()): CallPlanListResponse {
  return { data: [row], meta: { page: 1, limit: 20, total: 1 } }
}

/** Build a today envelope. */
function makeTodayEnvelope(row: CallPlanResponse = makePlan()): TodayCallPlansResponse {
  return { data: [row] }
}

/** Build a bulk-upload response with a partial-failure example. */
function makeBulkResponse(): BulkUploadResponse {
  return { data: { created: 2, errors: [{ index: 1, message: 'customer not found' }] } }
}

/** Build an analytics response with a Salesman-vs-MR summary. */
function makeAnalytics(): CallPlanAnalyticsResponse {
  return {
    data: [
      {
        user_id: 'u1',
        user_name: 'Andi',
        role_label: 'SALESMAN',
        total_planned: 20,
        total_visited: 18,
        call_rate_pct: 90
      }
    ],
    summary: {
      SALESMAN: { total_planned: 20, total_visited: 18, call_rate_pct: 90 },
      MR: { total_planned: 10, total_visited: 8, call_rate_pct: 80 }
    },
    meta: { month: 3, year: 2024, total_users: 2 }
  }
}

/**
 * API client stub with independently observable verbs. Each verb resolves a benign default so
 * method-specific endpoint/param assertions stay isolated.
 */
function makeApiClient(): {
  client: ApiClientApi
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () => makeListEnvelope())
  const post = vi.fn(async () => makeBulkResponse())
  const client: ApiClientApi = {
    get: get as unknown as ApiClientApi['get'],
    post: post as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete']
  }
  return { client, get, post }
}

/** A client whose every verb rejects with the given error, for error-path tests. */
function makeFailingApiClient(err: unknown): ApiClientApi {
  const reject = vi.fn(async () => {
    throw err
  })
  return {
    get: reject as unknown as ApiClientApi['get'],
    post: reject as unknown as ApiClientApi['post'],
    put: reject as unknown as ApiClientApi['put'],
    patch: reject as unknown as ApiClientApi['patch'],
    delete: reject as unknown as ApiClientApi['delete']
  }
}

describe('useCallPlans', () => {
  it('lists call plans with filters forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    const api = useCallPlans({ apiClient: client })

    const result = await api.listCallPlans({
      page: 2,
      limit: 20,
      user_id: 'u1',
      month: 3,
      year: 2024,
      is_approved: false
    })

    expect(get).toHaveBeenCalledWith('/call-plans', {
      query: { page: 2, limit: 20, user_id: 'u1', month: 3, year: 2024, is_approved: false }
    })
    expect(result.data[0]?.id).toBe('cp1')
    expect(api.error.value).toBeNull()
  })

  it('lists call plans with no filters as an empty query', async () => {
    const { client, get } = makeApiClient()
    const api = useCallPlans({ apiClient: client })

    await api.listCallPlans()

    expect(get).toHaveBeenCalledWith('/call-plans', { query: {} })
  })

  it('bulk-uploads plans via POST and surfaces created count + per-row errors', async () => {
    const { client, post } = makeApiClient()
    const api = useCallPlans({ apiClient: client })

    const input = {
      plans: [
        { user_id: 'u1', customer_id: 'cust1', plan_date: '2024-03-05' },
        { user_id: 'u2', customer_id: 'bad', outlet_context_id: null, plan_date: '2024-03-06' }
      ]
    }
    const result = await api.bulkUploadCallPlans(input)

    expect(post).toHaveBeenCalledWith('/call-plans/bulk-upload', { body: input })
    expect(result.data.created).toBe(2)
    expect(result.data.errors[0]).toEqual({ index: 1, message: 'customer not found' })
  })

  it('fetches today plans via GET to /call-plans/today with optional user override', async () => {
    const { client, get } = makeApiClient()
    get.mockResolvedValueOnce(makeTodayEnvelope())
    const api = useCallPlans({ apiClient: client })

    const result = await api.getTodayPlans({ user_id: 'u9' })

    expect(get).toHaveBeenCalledWith('/call-plans/today', { query: { user_id: 'u9' } })
    expect(result.data).toHaveLength(1)
  })

  it('fetches analytics via GET to /call-plans/analytics with month/year/role filter', async () => {
    const { client, get } = makeApiClient()
    get.mockResolvedValueOnce(makeAnalytics())
    const api = useCallPlans({ apiClient: client })

    const result = await api.getCallPlanAnalytics({ month: 3, year: 2024, role_filter: 'SALESMAN' })

    expect(get).toHaveBeenCalledWith('/call-plans/analytics', {
      query: { month: 3, year: 2024, role_filter: 'SALESMAN' }
    })
    expect(result.summary.SALESMAN.call_rate_pct).toBe(90)
    expect(result.summary.MR.call_rate_pct).toBe(80)
  })

  it('toggles isLoading around a successful request and clears error', async () => {
    const { client } = makeApiClient()
    const api = useCallPlans({ apiClient: client })

    const promise = api.listCallPlans()
    expect(api.isLoading.value).toBe(true)
    await promise

    expect(api.isLoading.value).toBe(false)
    expect(api.error.value).toBeNull()
  })

  it('captures and rethrows a typed ApiError on failure', async () => {
    const apiError = new ApiError({ code: 'FORBIDDEN', message: 'no access' }, 403)
    const api = useCallPlans({ apiClient: makeFailingApiClient(apiError) })

    await expect(api.getCallPlanAnalytics({ month: 1, year: 2024 })).rejects.toBe(apiError)
    expect(api.error.value).toBe(apiError)
    expect(api.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a REQUEST_FAILED ApiError', async () => {
    const api = useCallPlans({ apiClient: makeFailingApiClient(new Error('boom')) })

    await expect(
      api.bulkUploadCallPlans({ plans: [{ user_id: 'u1', customer_id: 'c1', plan_date: '2024-03-05' }] })
    ).rejects.toBeInstanceOf(ApiError)
    expect(api.error.value?.code).toBe('REQUEST_FAILED')
  })
})
