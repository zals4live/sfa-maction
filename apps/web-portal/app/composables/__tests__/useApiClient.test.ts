import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  useApiClient,
  type ApiClientOptions,
  type ApiFetch
} from '../useApiClient'

/** Build client options wired to injected fakes so tests never hit real endpoints. */
function makeOptions(fetcher: ApiFetch, extra: Partial<ApiClientOptions> = {}): ApiClientOptions {
  return {
    baseUrl: 'https://api.test/v1',
    fetcher,
    ssrCookie: null,
    ...extra
  }
}

/** Await a promise expected to reject and return the thrown value typed as ApiError. */
async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
    throw new Error('expected the promise to reject')
  } catch (err) {
    return err as ApiError
  }
}

describe('useApiClient (web-portal)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('joins the explicit base URL and sends credentials for online GET', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({ data: { id: 'c1' } }))
    const client = useApiClient(makeOptions(fetcher))

    const result = await client.get<{ data: { id: string } }>('/customers/c1')

    expect(result).toEqual({ data: { id: 'c1' } })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.test/v1/customers/c1')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('include')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('falls back to the relative /api base URL when none is configured', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    // No baseUrl and no Nuxt runtimeConfig global -> FALLBACK_BASE_URL.
    const client = useApiClient({ fetcher, ssrCookie: null })

    await client.get('/health')

    const [url] = fetcher.mock.calls[0]!
    expect(url).toBe('/api/health')
  })

  it('forwards the SSR cookie header so tenant context reaches the backend', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher, { ssrCookie: 'maction_token=jwt-abc' }))

    await client.get('/auth/me')

    const [, init] = fetcher.mock.calls[0]!
    expect(init.headers.Cookie).toBe('maction_token=jwt-abc')
  })

  it('omits the Cookie header on the client (no SSR cookie available)', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher))

    await client.get('/auth/me')

    const [, init] = fetcher.mock.calls[0]!
    expect(init.headers.Cookie).toBeUndefined()
  })

  it('attaches an explicit bearer token when a token provider is supplied', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher, { getToken: () => 'jwt-token' }))

    await client.get('/dashboard')

    const [, init] = fetcher.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
  })

  it('maps the backend error contract into a typed ApiError', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => {
      throw {
        status: 403,
        data: {
          error: {
            code: 'FORBIDDEN_ROLE',
            message: 'MR cannot access orders.',
            details: { role: 'MR' }
          }
        }
      }
    })
    const client = useApiClient(makeOptions(fetcher))

    const error = await captureApiError(client.get('/orders'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('FORBIDDEN_ROLE')
    expect(error.status).toBe(403)
    expect(error.details).toEqual({ role: 'MR' })
  })

  it('surfaces a generic ApiError for unstructured failures (no internals leaked)', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => {
      throw new Error('ECONNREFUSED at pg://internal:5432')
    })
    const client = useApiClient(makeOptions(fetcher))

    const error = await captureApiError(client.get('/reports'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('REQUEST_FAILED')
    expect(error.status).toBe(0)
    expect(error.message).not.toContain('pg://')
  })

  it('performs an online POST via the transport with a JSON body', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({ data: { id: 't1' } }))
    const client = useApiClient(makeOptions(fetcher))

    const result = await client.post('/tenants', { body: { name: 'KFTD' } })

    expect(result).toEqual({ data: { id: 't1' } })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.test/v1/tenants')
    expect(init.method).toBe('POST')
    expect(init.body).toEqual({ name: 'KFTD' })
    expect(init.credentials).toBe('include')
  })

  it('passes query parameters through on GET', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher))

    await client.get('/customers', { query: { page: 1, limit: 20 } })

    const [, init] = fetcher.mock.calls[0]!
    expect(init.query).toEqual({ page: 1, limit: 20 })
  })

  it('exposes put, patch, and delete verbs mapping to the correct HTTP method', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher))

    await client.put('/customers/c1', { body: { name: 'X' } })
    await client.patch('/customers/c1', { body: { name: 'Y' } })
    await client.delete('/customers/c1')

    expect(fetcher.mock.calls[0]![1].method).toBe('PUT')
    expect(fetcher.mock.calls[1]![1].method).toBe('PATCH')
    expect(fetcher.mock.calls[2]![1].method).toBe('DELETE')
  })
})
