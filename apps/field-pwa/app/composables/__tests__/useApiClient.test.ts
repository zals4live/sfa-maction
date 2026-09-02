// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie
// singleton (reached transitively when useApiClient falls back to the real
// useBackgroundSync/useOfflineDb) can run under Node. It MUST be imported before any
// module that touches the `db` singleton. The tests below inject fakes and never hit it,
// but the import keeps the module graph safe under the `node` Vitest environment.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserRole, type ConnectivityState } from '@maction/types'
import type { BackgroundSyncApi, OutboxDraft } from '../useBackgroundSync'
import {
  ApiError,
  AUTH_TOKEN_STORAGE_KEY,
  useApiClient,
  type ApiClientOptions,
  type ApiFetch,
  type MutationOptions
} from '../useApiClient'

const IDENTITY = {
  company_id: 'company-a',
  user_id: 'user-1',
  user_role: UserRole.SALESMAN
}

/** Force `navigator.onLine` for a test; returns a restore fn. */
function setOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: value },
    configurable: true,
    writable: true
  })
  return () => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

/** A background-sync stub that records enqueued drafts without touching Dexie. */
function makeSyncStub(): BackgroundSyncApi & { enqueued: OutboxDraft[] } {
  const enqueued: OutboxDraft[] = []
  return {
    enqueued,
    connectivity: { value: 'ONLINE' as ConnectivityState } as BackgroundSyncApi['connectivity'],
    pendingCount: { value: 0 } as BackgroundSyncApi['pendingCount'],
    enqueue: vi.fn(async (draft: OutboxDraft) => {
      enqueued.push(draft)
      return draft.id
    }),
    flush: vi.fn(async () => ({ synced: 0, failed: 0 })),
    registerBackgroundSync: vi.fn(async () => {}),
    startConnectivityWatch: vi.fn(),
    stopConnectivityWatch: vi.fn(),
    refreshPendingCount: vi.fn(async () => {})
  }
}

/** Build client options wired to injected fakes so tests never hit real endpoints. */
function makeOptions(fetcher: ApiFetch, extra: Partial<ApiClientOptions> = {}): ApiClientOptions {
  return {
    baseUrl: 'https://api.test/v1',
    getToken: () => 'jwt-token',
    fetcher,
    sync: makeSyncStub(),
    ...extra
  }
}

const mutationOptions = (over: Partial<MutationOptions> = {}): MutationOptions => ({
  identity: IDENTITY,
  mutationType: 'ORDER_SUBMIT',
  body: { order_id: 'o1' },
  ...over
})

/** Await a promise expected to reject and return the thrown value typed as ApiError. */
async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
    throw new Error('expected the promise to reject')
  } catch (err) {
    return err as ApiError
  }
}

describe('useApiClient', () => {
  let restoreOnline: () => void

  beforeEach(() => {
    restoreOnline = setOnline(true)
  })

  afterEach(() => {
    restoreOnline()
    vi.restoreAllMocks()
  })

  it('attaches the bearer token and joins the base URL for online GET', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({ data: { id: 'c1' } }))
    const client = useApiClient(makeOptions(fetcher))

    const result = await client.get<{ data: { id: string } }>('/customers/c1')

    expect(result).toEqual({ data: { id: 'c1' } })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.test/v1/customers/c1')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer jwt-token')
  })

  it('omits the Authorization header when no token is available', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher, { getToken: () => null }))

    await client.get('/materials')

    const [, init] = fetcher.mock.calls[0]!
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('maps the backend error contract into a typed ApiError', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => {
      throw {
        status: 400,
        data: {
          error: {
            code: 'GEOFENCE_OUT_OF_RANGE',
            message: 'You are 250m from the target location.',
            details: { distance_meters: 250 }
          }
        }
      }
    })
    const client = useApiClient(makeOptions(fetcher))

    const error = await captureApiError(client.get('/visits/v1'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('GEOFENCE_OUT_OF_RANGE')
    expect(error.status).toBe(400)
    expect(error.details).toEqual({ distance_meters: 250 })
  })

  it('surfaces a generic ApiError for unstructured failures (no internals leaked)', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => {
      throw new Error('ECONNREFUSED at pg://internal:5432')
    })
    const client = useApiClient(makeOptions(fetcher))

    const error = await captureApiError(client.get('/materials'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('REQUEST_FAILED')
    expect(error.message).not.toContain('pg://')
  })

  it('falls back to the cached resolver on offline GET', async () => {
    restoreOnline()
    restoreOnline = setOnline(false)
    const fetcher = vi.fn<ApiFetch>()
    const client = useApiClient(makeOptions(fetcher))

    const cached = [{ id: 'c1' }]
    const result = await client.get('/customers', { offlineFallback: () => cached })

    expect(fetcher).not.toHaveBeenCalled()
    expect(result).toBe(cached)
    expect(client.connectivity.value).toBe('OFFLINE')
  })

  it('throws OFFLINE_NO_CACHE on offline GET without a fallback', async () => {
    restoreOnline()
    restoreOnline = setOnline(false)
    const client = useApiClient(makeOptions(vi.fn<ApiFetch>()))

    const error = await captureApiError(client.get('/customers'))

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('OFFLINE_NO_CACHE')
  })

  it('performs an online POST via the transport', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({ data: { id: 'o1' } }))
    const client = useApiClient(makeOptions(fetcher))

    const result = await client.post('/orders', mutationOptions())

    expect(result).toEqual({ data: { id: 'o1' } })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.test/v1/orders')
    expect(init.method).toBe('POST')
    expect(init.body).toEqual({ order_id: 'o1' })
  })

  it('queues an offline POST to the outbox with the capturing user_role', async () => {
    restoreOnline()
    restoreOnline = setOnline(false)
    const fetcher = vi.fn<ApiFetch>()
    const sync = makeSyncStub()
    const client = useApiClient(makeOptions(fetcher, { sync }))

    const result = await client.post('/orders', mutationOptions({ mutationId: 'm1' }))

    expect(fetcher).not.toHaveBeenCalled()
    expect(result).toEqual({ queued: true, mutationId: 'm1' })
    expect(sync.enqueued).toHaveLength(1)
    const draft = sync.enqueued[0]!
    expect(draft.user_role).toBe(UserRole.SALESMAN)
    expect(draft.http_method).toBe('POST')
    expect(draft.endpoint).toBe('https://api.test/v1/orders')
    expect(draft.mutation_type).toBe('ORDER_SUBMIT')
    expect(draft.payload).toEqual({ order_id: 'o1' })
  })

  it('generates a mutation id when none is provided for an offline mutation', async () => {
    restoreOnline()
    restoreOnline = setOnline(false)
    const sync = makeSyncStub()
    const client = useApiClient(makeOptions(vi.fn<ApiFetch>(), { sync }))

    const result = await client.put('/customers/c1', mutationOptions({ mutationType: 'AGENDA_CREATE' }))

    expect(result).toMatchObject({ queued: true })
    expect(sync.enqueued[0]!.id).toBeTruthy()
  })

  it('reads the token from local storage by default', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const store = new Map<string, string>([[AUTH_TOKEN_STORAGE_KEY, 'stored-jwt']])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null
    })
    // Note: relies on the default token provider, so getToken is not overridden here.
    const client = useApiClient({ baseUrl: 'https://api.test/v1', fetcher, sync: makeSyncStub() })

    await client.get('/auth/me')

    const [, init] = fetcher.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer stored-jwt')
  })

  it('exposes reactive connectivity that flips to ONLINE after a successful request', async () => {
    const fetcher = vi.fn<ApiFetch>(async () => ({}))
    const client = useApiClient(makeOptions(fetcher))

    await client.get('/health')

    expect(client.connectivity.value).toBe('ONLINE')
  })
})
