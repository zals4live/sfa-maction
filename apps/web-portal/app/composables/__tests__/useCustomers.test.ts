import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  buildCustomerBody,
  useCustomers,
  type CreateCustomerInput,
  type CustomerListResponse,
  type CustomerMutationResponse,
  type UpdateCustomerInput
} from '../useCustomers'

/** Build a single customer-response fixture, overriding fields per test. */
function makeCustomer(
  overrides: Partial<CustomerMutationResponse['data']> = {}
): CustomerMutationResponse['data'] {
  return {
    id: 'c1',
    company_id: 'co1',
    soffice_id: 's1',
    customer_type: 'OUTLET',
    erp_customer_code: null,
    name: 'Apotek Sehat',
    customer_group: null,
    address: null,
    city: 'Jakarta',
    latitude: null,
    longitude: null,
    credit_limit: null,
    credit_term_days: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

/** Build a paginated list envelope around a customer array. */
function makeListResponse(): CustomerListResponse {
  return { data: [makeCustomer()], meta: { page: 1, limit: 20, total: 1 } }
}

/**
 * Build an API client stub with independently observable verbs. Each verb resolves the
 * matching fixture so method-specific endpoint/param assertions stay isolated.
 */
function makeApiClient(): {
  client: ApiClientApi
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () => makeListResponse())
  const post = vi.fn(async () => ({ data: makeCustomer() }))
  const patch = vi.fn(async () => ({ data: makeCustomer() }))
  const del = vi.fn(async () => ({ data: { success: true } }))
  const client: ApiClientApi = {
    get: get as unknown as ApiClientApi['get'],
    post: post as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: patch as unknown as ApiClientApi['patch'],
    delete: del as unknown as ApiClientApi['delete']
  }
  return { client, get, post, patch, delete: del }
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

describe('buildCustomerBody', () => {
  it('nests lat/lng under location when both are present', () => {
    const body = buildCustomerBody<CustomerFormLike>({ latitude: -6.2, longitude: 106.8, city: 'Jakarta' })
    expect(body).toEqual({ city: 'Jakarta', location: { latitude: -6.2, longitude: 106.8 } })
  })

  it('omits location when either coordinate is missing', () => {
    expect(buildCustomerBody<CustomerFormLike>({ latitude: -6.2, city: 'Jakarta' }))
      .toEqual({ city: 'Jakarta' })
    expect(buildCustomerBody<CustomerFormLike>({ latitude: null, longitude: null }))
      .toEqual({})
  })
})

/** Minimal structural form shape reused across buildCustomerBody assertions. */
type CustomerFormLike = { latitude?: number | null, longitude?: number | null, city?: string | null }

describe('useCustomers', () => {
  it('lists customers with filters forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    const customers = useCustomers({ apiClient: client })

    const response = await customers.listCustomers({
      page: 2,
      search: 'apotek',
      customer_type: 'OUTLET',
      is_active: true
    })

    expect(get).toHaveBeenCalledWith('/customers', {
      query: { page: 2, search: 'apotek', customer_type: 'OUTLET', is_active: true }
    })
    expect(response.meta.total).toBe(1)
    expect(customers.error.value).toBeNull()
  })

  it('fetches a single customer by id', async () => {
    const { client, get } = makeApiClient()
    const customers = useCustomers({ apiClient: client })

    await customers.getCustomer('c1')

    expect(get).toHaveBeenCalledWith('/customers/c1')
  })

  it('creates a customer, nesting coordinates under location', async () => {
    const { client, post } = makeApiClient()
    const customers = useCustomers({ apiClient: client })

    const input: CreateCustomerInput = {
      customer_type: 'DOCTOR',
      soffice_id: 's1',
      name: 'dr. Budi',
      latitude: -6.2,
      longitude: 106.8,
      is_active: true
    }
    await customers.createCustomer(input)

    expect(post).toHaveBeenCalledWith('/customers', {
      body: {
        customer_type: 'DOCTOR',
        soffice_id: 's1',
        name: 'dr. Budi',
        is_active: true,
        location: { latitude: -6.2, longitude: 106.8 }
      }
    })
  })

  it('updates a customer via PATCH to the id path', async () => {
    const { client, patch } = makeApiClient()
    const customers = useCustomers({ apiClient: client })

    const input: UpdateCustomerInput = { name: 'Apotek Baru', is_active: false }
    await customers.updateCustomer('c1', input)

    expect(patch).toHaveBeenCalledWith('/customers/c1', {
      body: { name: 'Apotek Baru', is_active: false }
    })
  })

  it('soft-deletes a customer via DELETE to the id path', async () => {
    const { client, delete: del } = makeApiClient()
    const customers = useCustomers({ apiClient: client })

    const response = await customers.deleteCustomer('c1')

    expect(del).toHaveBeenCalledWith('/customers/c1')
    expect(response.data.success).toBe(true)
  })

  it('captures a typed ApiError on failure and re-throws it', async () => {
    const apiError = new ApiError({ code: 'FORBIDDEN', message: 'denied' }, 403)
    const customers = useCustomers({ apiClient: makeFailingApiClient(apiError) })

    await expect(customers.listCustomers()).rejects.toBe(apiError)
    expect(customers.error.value).toBe(apiError)
    expect(customers.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a typed ApiError', async () => {
    const customers = useCustomers({ apiClient: makeFailingApiClient(new Error('boom')) })

    await expect(customers.createCustomer({
      customer_type: 'OUTLET',
      soffice_id: 's1',
      name: 'X'
    })).rejects.toBeInstanceOf(ApiError)
    expect(customers.error.value?.code).toBe('REQUEST_FAILED')
  })
})
