import { describe, expect, it, vi } from 'vitest'
import { ERPSystemType } from '@maction/types'
import { ApiError, type ApiClientApi } from '../useApiClient'
import { useTenantAdmin, type TenantResponse } from '../useTenantAdmin'

/** Build a single tenant fixture, overriding fields per test. */
function makeTenant(overrides: Partial<TenantResponse> = {}): TenantResponse {
  return {
    id: 't1',
    code: 'KFTD',
    name: 'Kimia Farma Trading & Distribution',
    is_active: true,
    logo_s3_key: null,
    default_tax_rate: 11,
    geofence_radius_meters: 100,
    checkout_min_hour: 16,
    erp_system_type: null,
    erp_endpoint_url: null,
    erp_auth_config: null,
    erp_company_code: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

/** Build a paginated tenant-list envelope. */
function makeListEnvelope(row: TenantResponse): {
  data: TenantResponse[]
  meta: { page: number, limit: number, total: number }
} {
  return { data: [row], meta: { page: 1, limit: 20, total: 1 } }
}

/**
 * API client stub with independently observable verbs. Each verb resolves a benign default so
 * method-specific endpoint/param assertions stay isolated.
 */
function makeApiClient(): {
  client: ApiClientApi
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () => makeListEnvelope(makeTenant()))
  const post = vi.fn(async () => ({ data: makeTenant() }))
  const patch = vi.fn(async () => ({ data: makeTenant() }))
  const put = vi.fn(async () => ({ data: makeTenant() }))
  const client: ApiClientApi = {
    get: get as unknown as ApiClientApi['get'],
    post: post as unknown as ApiClientApi['post'],
    put: put as unknown as ApiClientApi['put'],
    patch: patch as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete']
  }
  return { client, get, post, patch, put }
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

describe('useTenantAdmin', () => {
  it('lists tenants with pagination + search forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    const tenants = useTenantAdmin({ apiClient: client })

    await tenants.listTenants({ page: 2, limit: 20, search: 'kf' })

    expect(get).toHaveBeenCalledWith('/tenants', {
      query: { page: 2, limit: 20, search: 'kf' }
    })
    expect(tenants.error.value).toBeNull()
  })

  it('creates a tenant via POST to /tenants', async () => {
    const { client, post } = makeApiClient()
    const tenants = useTenantAdmin({ apiClient: client })

    await tenants.createTenant({
      code: 'KFA',
      name: 'Kimia Farma Apotek',
      default_tax_rate: 11,
      geofence_radius_meters: 100,
      checkout_min_hour: 16
    })

    expect(post).toHaveBeenCalledWith('/tenants', {
      body: {
        code: 'KFA',
        name: 'Kimia Farma Apotek',
        default_tax_rate: 11,
        geofence_radius_meters: 100,
        checkout_min_hour: 16
      }
    })
  })

  it('updates a tenant via PATCH to /tenants/:id', async () => {
    const { client, patch } = makeApiClient()
    const tenants = useTenantAdmin({ apiClient: client })

    await tenants.updateTenant('t1', { name: 'Renamed', default_tax_rate: 10 })

    expect(patch).toHaveBeenCalledWith('/tenants/t1', {
      body: { name: 'Renamed', default_tax_rate: 10 }
    })
  })

  it('deactivates a tenant (kill-switch) via PATCH to /tenants/:id/deactivate', async () => {
    const { client, patch } = makeApiClient()
    patch.mockResolvedValueOnce({ data: { success: true } })
    const tenants = useTenantAdmin({ apiClient: client })

    const response = await tenants.deactivateTenant('t1')

    expect(patch).toHaveBeenCalledWith('/tenants/t1/deactivate')
    expect(response.data.success).toBe(true)
  })

  it('updates ERP config via PUT to /tenants/:id/erp-config', async () => {
    const { client, put } = makeApiClient()
    const tenants = useTenantAdmin({ apiClient: client })

    await tenants.updateERPConfig('t1', {
      erp_system_type: ERPSystemType.SAP_S4HANA,
      erp_endpoint_url: 'https://erp.example.com',
      erp_company_code: '1000',
      erp_auth_config: { client_id: 'abc' }
    })

    expect(put).toHaveBeenCalledWith('/tenants/t1/erp-config', {
      body: {
        erp_system_type: ERPSystemType.SAP_S4HANA,
        erp_endpoint_url: 'https://erp.example.com',
        erp_company_code: '1000',
        erp_auth_config: { client_id: 'abc' }
      }
    })
  })

  it('toggles isLoading around a successful request and clears error', async () => {
    const { client } = makeApiClient()
    const tenants = useTenantAdmin({ apiClient: client })

    const promise = tenants.listTenants()
    expect(tenants.isLoading.value).toBe(true)
    await promise

    expect(tenants.isLoading.value).toBe(false)
    expect(tenants.error.value).toBeNull()
  })

  it('captures and rethrows a typed ApiError on failure', async () => {
    const apiError = new ApiError({ code: 'COMPANY_NOT_FOUND', message: 'missing' }, 404)
    const tenants = useTenantAdmin({ apiClient: makeFailingApiClient(apiError) })

    await expect(tenants.deactivateTenant('t1')).rejects.toBe(apiError)
    expect(tenants.error.value).toBe(apiError)
    expect(tenants.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a REQUEST_FAILED ApiError', async () => {
    const tenants = useTenantAdmin({ apiClient: makeFailingApiClient(new Error('boom')) })

    await expect(
      tenants.createTenant({ code: 'X', name: 'Y' })
    ).rejects.toBeInstanceOf(ApiError)
    expect(tenants.error.value?.code).toBe('REQUEST_FAILED')
  })
})
