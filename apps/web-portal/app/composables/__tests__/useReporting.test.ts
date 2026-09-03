import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  useReporting,
  DEFAULT_REPORTING_TTL_MS,
  type DashboardKpiResponse,
  type UseReportingOptions
} from '../useReporting'

/** Minimal dashboard KPI response fixture, overriding fields per test. */
function makeKpi(revenue = 1000): DashboardKpiResponse {
  return {
    data: {
      period: 'month',
      total_active_users: 5,
      total_orders: 12,
      total_revenue: revenue,
      SALESMAN: { total_visits: 20, effective_calls: 18, call_rate_pct: 90 },
      MR: { total_visits: 10, effective_calls: 9, call_rate_pct: 90 }
    },
    meta: { soffice_id: null, generated_at: '2024-01-01T00:00:00Z' }
  }
}

/**
 * Build an API client stub whose GET resolves the next value from `values` (falling back to
 * the last). The generic `get<T>` surface is satisfied by casting the fixed-return impl.
 */
function makeApiClient(
  values: unknown[] = [makeKpi()]
): { client: ApiClientApi, get: ReturnType<typeof vi.fn> } {
  let call = 0
  const get = vi.fn(async () => values[Math.min(call++, values.length - 1)])
  const client: ApiClientApi = {
    get: get as unknown as ApiClientApi['get'],
    post: vi.fn() as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete']
  }
  return { client, get }
}

/** A rejecting API client for error-path tests. */
function makeFailingApiClient(err: unknown): ApiClientApi {
  const reject = vi.fn(async () => {
    throw err
  })
  return {
    get: reject as unknown as ApiClientApi['get'],
    post: vi.fn() as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete']
  }
}

/** Wire options with an injected API client and a controllable clock. */
function makeOptions(extra: Partial<UseReportingOptions> = {}): UseReportingOptions {
  return {
    apiClient: makeApiClient().client,
    ...extra
  }
}

describe('useReporting (web-portal)', () => {
  it('fetches a report and exposes the typed response', async () => {
    const { client, get } = makeApiClient([makeKpi(2500)])
    const reporting = useReporting(makeOptions({ apiClient: client }))

    const result = await reporting.fetchDashboardKpi({ period: 'month' })

    expect(get).toHaveBeenCalledWith('/reports/dashboard-kpi', { query: { period: 'month' } })
    expect(result.data.total_revenue).toBe(2500)
    expect(reporting.isLoading.value).toBe(false)
    expect(reporting.error.value).toBeNull()
  })

  it('returns the cached value on a repeat call within TTL (no second fetch)', async () => {
    const { client, get } = makeApiClient([makeKpi(100), makeKpi(999)])
    let clock = 1_000
    const reporting = useReporting(makeOptions({ apiClient: client, now: () => clock }))

    const first = await reporting.fetchDashboardKpi({ period: 'month' })
    clock += DEFAULT_REPORTING_TTL_MS - 1 // still fresh
    const second = await reporting.fetchDashboardKpi({ period: 'month' })

    expect(get).toHaveBeenCalledTimes(1)
    expect(second.data.total_revenue).toBe(first.data.total_revenue)
    expect(second.data.total_revenue).toBe(100)
  })

  it('refetches after the TTL expires (cache miss)', async () => {
    const { client, get } = makeApiClient([makeKpi(100), makeKpi(999)])
    let clock = 1_000
    const reporting = useReporting(makeOptions({ apiClient: client, now: () => clock }))

    await reporting.fetchDashboardKpi({ period: 'month' })
    clock += DEFAULT_REPORTING_TTL_MS // exactly at expiry -> stale
    const second = await reporting.fetchDashboardKpi({ period: 'month' })

    expect(get).toHaveBeenCalledTimes(2)
    expect(second.data.total_revenue).toBe(999)
  })

  it('bypasses the cache when force is set', async () => {
    const { client, get } = makeApiClient([makeKpi(100), makeKpi(999)])
    const reporting = useReporting(makeOptions({ apiClient: client, now: () => 1_000 }))

    await reporting.fetchDashboardKpi({ period: 'month' })
    const second = await reporting.fetchDashboardKpi({ period: 'month' }, { force: true })

    expect(get).toHaveBeenCalledTimes(2)
    expect(second.data.total_revenue).toBe(999)
  })

  it('keys the cache by serialized query params (different params miss)', async () => {
    const { client, get } = makeApiClient([makeKpi(1), makeKpi(2)])
    const reporting = useReporting(makeOptions({ apiClient: client }))

    await reporting.fetchDashboardKpi({ period: 'month' })
    await reporting.fetchDashboardKpi({ period: 'week' })

    expect(get).toHaveBeenCalledTimes(2)
  })

  it('clearCache evicts entries so the next call refetches', async () => {
    const { client, get } = makeApiClient([makeKpi(1), makeKpi(2)])
    const reporting = useReporting(makeOptions({ apiClient: client, now: () => 1_000 }))

    await reporting.fetchDashboardKpi({ period: 'month' })
    reporting.clearCache()
    await reporting.fetchDashboardKpi({ period: 'month' })

    expect(get).toHaveBeenCalledTimes(2)
  })

  it('propagates ApiError and stores it on the reactive error ref', async () => {
    const apiError = new ApiError({ code: 'FORBIDDEN', message: 'no access' }, 403)
    const reporting = useReporting(makeOptions({ apiClient: makeFailingApiClient(apiError) }))

    await expect(reporting.fetchCallRate({ month: 1, year: 2024 })).rejects.toBe(apiError)
    expect(reporting.error.value).toBe(apiError)
    expect(reporting.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a typed ApiError', async () => {
    const reporting = useReporting(makeOptions({ apiClient: makeFailingApiClient(new Error('boom')) }))

    const caught = await reporting
      .fetchOrderRegister({})
      .catch((err: unknown) => err as ApiError)

    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).code).toBe('REQUEST_FAILED')
  })

  it('builds an export URL with the report scope encoded as query params', () => {
    const reporting = useReporting(makeOptions({ exportBaseUrl: 'https://api.test/v1' }))

    const url = reporting.buildExportUrl({
      type: 'xlsx',
      report: 'branch-performance',
      month: 3,
      year: 2024
    })

    expect(url).toBe('https://api.test/v1/reports/export/xlsx?month=3&report=branch-performance&year=2024')
  })

  it('downloadExport is a no-op off-browser (no document) and does not throw', () => {
    const reporting = useReporting(makeOptions({ exportBaseUrl: 'https://api.test/v1' }))

    expect(() =>
      reporting.downloadExport({ type: 'pdf', report: 'orders' })
    ).not.toThrow()
  })

  it('works without a Nuxt runtime by degrading useState to a local ref', async () => {
    // No stateFactory injected and no global useState -> local ref fallback, no throw.
    const { client, get } = makeApiClient([makeKpi(1)])
    const reporting = useReporting({ apiClient: client, now: () => 1_000 })

    await reporting.fetchDashboardKpi({ period: 'month' })
    await reporting.fetchDashboardKpi({ period: 'month' })

    expect(get).toHaveBeenCalledTimes(1) // cached via the local-ref fallback
  })

  it('honors an injected state factory for cross-page cache sharing', async () => {
    const shared = { value: {} as Record<string, unknown> }
    const stateFactory = vi.fn(<T>(_key: string, init: () => T) => {
      if (Object.keys(shared.value).length === 0) shared.value = init() as Record<string, unknown>
      return shared as unknown as { value: T }
    })
    const { client } = makeApiClient([makeKpi(7)])
    const reporting = useReporting({
      apiClient: client,
      now: () => 1_000,
      stateFactory: stateFactory as unknown as UseReportingOptions['stateFactory']
    })

    await reporting.fetchDashboardKpi({ period: 'month' })

    expect(Object.keys(shared.value).length).toBe(1)
  })
})
