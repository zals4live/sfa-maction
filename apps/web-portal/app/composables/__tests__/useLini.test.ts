import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  useLini,
  type LiniResponse,
  type UserLiniAssignmentResponse,
  type VarianResponse
} from '../useLini'

/** Build a single lini fixture, overriding fields per test. */
function makeLini(overrides: Partial<LiniResponse> = {}): LiniResponse {
  return {
    id: 'l1',
    company_id: 'c1',
    code: 'FARMA_ETHICAL',
    name: 'Farma Ethical',
    description: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

/** Build a single varian fixture, overriding fields per test. */
function makeVarian(overrides: Partial<VarianResponse> = {}): VarianResponse {
  return {
    id: 'v1',
    company_id: 'c1',
    code: 'REGULAR',
    name: 'Regular',
    description: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

/** Build a single user-lini assignment fixture. */
function makeAssignment(
  overrides: Partial<UserLiniAssignmentResponse> = {}
): UserLiniAssignmentResponse {
  return {
    id: 'ul1',
    company_id: 'c1',
    user_id: 'u1',
    lini_id: 'l1',
    lini_code: 'FARMA_ETHICAL',
    lini_name: 'Farma Ethical',
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

/** Build a paginated master-list envelope. */
function makeListEnvelope<T>(row: T): { data: T[], meta: { page: number, limit: number, total: number } } {
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
  delete: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () => makeListEnvelope(makeLini()))
  const post = vi.fn(async () => ({ data: makeLini() }))
  const patch = vi.fn(async () => ({ data: makeLini() }))
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

describe('useLini', () => {
  it('lists lini with filters forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.listLini({ page: 2, search: 'farma', is_active: true })

    expect(get).toHaveBeenCalledWith('/lini', {
      query: { page: 2, search: 'farma', is_active: true }
    })
    expect(lini.error.value).toBeNull()
  })

  it('creates a lini via POST to /lini', async () => {
    const { client, post } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.createLini({ code: 'OTC', name: 'Over The Counter', is_active: true })

    expect(post).toHaveBeenCalledWith('/lini', {
      body: { code: 'OTC', name: 'Over The Counter', is_active: true }
    })
  })

  it('updates a lini via PATCH to /lini/:id', async () => {
    const { client, patch } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.updateLini('l1', { name: 'Renamed', is_active: false })

    expect(patch).toHaveBeenCalledWith('/lini/l1', {
      body: { name: 'Renamed', is_active: false }
    })
  })

  it('soft-deletes a lini via DELETE to /lini/:id', async () => {
    const { client, delete: del } = makeApiClient()
    const lini = useLini({ apiClient: client })

    const response = await lini.deleteLini('l1')

    expect(del).toHaveBeenCalledWith('/lini/l1')
    expect(response.data.success).toBe(true)
  })

  it('lists varian with filters forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    get.mockResolvedValueOnce(makeListEnvelope(makeVarian()))
    const lini = useLini({ apiClient: client })

    const result = await lini.listVarian({ search: 'reg' })

    expect(get).toHaveBeenCalledWith('/varian', { query: { search: 'reg' } })
    expect(result.data[0]?.code).toBe('REGULAR')
  })

  it('creates a varian via POST to /varian', async () => {
    const { client, post } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.createVarian({ code: 'TENDER', name: 'Tender' })

    expect(post).toHaveBeenCalledWith('/varian', { body: { code: 'TENDER', name: 'Tender' } })
  })

  it('updates a varian via PATCH to /varian/:id', async () => {
    const { client, patch } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.updateVarian('v1', { name: 'Renamed Varian' })

    expect(patch).toHaveBeenCalledWith('/varian/v1', { body: { name: 'Renamed Varian' } })
  })

  it('soft-deletes a varian via DELETE to /varian/:id', async () => {
    const { client, delete: del } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.deleteVarian('v1')

    expect(del).toHaveBeenCalledWith('/varian/v1')
  })

  it('lists a user\'s lini assignments via GET to /users/:id/lini', async () => {
    const { client, get } = makeApiClient()
    get.mockResolvedValueOnce({ data: [makeAssignment()] })
    const lini = useLini({ apiClient: client })

    const result = await lini.listUserLini('u1', { is_active: true })

    expect(get).toHaveBeenCalledWith('/users/u1/lini', { query: { is_active: true } })
    expect(result.data[0]?.lini_code).toBe('FARMA_ETHICAL')
  })

  it('batch-assigns lini to a user via POST with lini_ids', async () => {
    const { client, post } = makeApiClient()
    post.mockResolvedValueOnce({ data: [makeAssignment()] })
    const lini = useLini({ apiClient: client })

    await lini.assignUserLini('u1', ['l1', 'l2'])

    expect(post).toHaveBeenCalledWith('/users/u1/lini', { body: { lini_ids: ['l1', 'l2'] } })
  })

  it('removes a single lini assignment via DELETE to /users/:id/lini/:liniId', async () => {
    const { client, delete: del } = makeApiClient()
    const lini = useLini({ apiClient: client })

    await lini.removeUserLini('u1', 'l1')

    expect(del).toHaveBeenCalledWith('/users/u1/lini/l1')
  })

  it('toggles isLoading around a successful request and clears error', async () => {
    const { client } = makeApiClient()
    const lini = useLini({ apiClient: client })

    const promise = lini.listLini()
    expect(lini.isLoading.value).toBe(true)
    await promise

    expect(lini.isLoading.value).toBe(false)
    expect(lini.error.value).toBeNull()
  })

  it('captures and rethrows a typed ApiError on failure', async () => {
    const apiError = new ApiError({ code: 'LINI_NOT_FOUND', message: 'missing' }, 404)
    const lini = useLini({ apiClient: makeFailingApiClient(apiError) })

    await expect(lini.deleteLini('l1')).rejects.toBe(apiError)
    expect(lini.error.value).toBe(apiError)
    expect(lini.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a REQUEST_FAILED ApiError', async () => {
    const lini = useLini({ apiClient: makeFailingApiClient(new Error('boom')) })

    await expect(lini.createLini({ code: 'X', name: 'Y' })).rejects.toBeInstanceOf(ApiError)
    expect(lini.error.value?.code).toBe('REQUEST_FAILED')
  })
})
