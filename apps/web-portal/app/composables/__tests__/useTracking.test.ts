import { describe, expect, it, vi } from 'vitest'
import { UserRole } from '@maction/types'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  useTracking,
  type IntervalScheduler,
  type LivePositionsResponse,
  type TrackedUser,
  type UseTrackingOptions
} from '../useTracking'

/** Build a single tracked-user fixture, overriding fields per test. */
function makeUser(overrides: Partial<TrackedUser> = {}): TrackedUser {
  return {
    user_id: 'u1',
    user_name: 'Andi',
    role_label: UserRole.SALESMAN,
    soffice_id: 's1',
    lat: -6.2,
    lng: 106.8,
    timestamp: '2024-01-01T00:00:00Z',
    breadcrumbs: [],
    ...overrides
  }
}

/** Build a live-positions response fixture around a user list. */
function makeResponse(users: TrackedUser[] = [makeUser()]): LivePositionsResponse {
  return { data: users, meta: { soffice_id: null, generated_at: '2024-01-01T00:00:00Z' } }
}

/** Build an API client stub whose GET resolves successive `values` (falling back to last). */
function makeApiClient(values: unknown[] = [makeResponse()]): {
  client: ApiClientApi
  get: ReturnType<typeof vi.fn>
} {
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

/**
 * A manually-driven interval scheduler: `set` records the handler; `run` invokes it. Lets
 * tests advance polling ticks deterministically without real timers.
 */
function makeScheduler(): { scheduler: IntervalScheduler, run: () => void, cleared: () => boolean } {
  let handler: (() => void) | null = null
  let clearedFlag = false
  const scheduler: IntervalScheduler = {
    set: (h) => {
      handler = h
      return 1
    },
    clear: () => {
      clearedFlag = true
      handler = null
    }
  }
  return {
    scheduler,
    run: () => handler?.(),
    cleared: () => clearedFlag
  }
}

function makeOptions(extra: Partial<UseTrackingOptions> = {}): UseTrackingOptions {
  return { now: () => 1_000, ...extra }
}

describe('useTracking', () => {
  it('fetches and publishes the position snapshot', async () => {
    const { client, get } = makeApiClient([makeResponse([makeUser(), makeUser({ user_id: 'u2', role_label: UserRole.MR })])])
    const tracking = useTracking(makeOptions({ apiClient: client }))

    const response = await tracking.fetchPositions()

    expect(get).toHaveBeenCalledWith('/tracking/live-positions', { query: {} })
    expect(response.data).toHaveLength(2)
    expect(tracking.positions.value).toHaveLength(2)
    expect(tracking.lastUpdatedAt.value).toBe(1_000)
    expect(tracking.error.value).toBeNull()
  })

  it('forwards the role filter as a query param', async () => {
    const { client, get } = makeApiClient()
    const tracking = useTracking(makeOptions({ apiClient: client }))

    await tracking.fetchPositions({ role: UserRole.MR })

    expect(get).toHaveBeenCalledWith('/tracking/live-positions', { query: { role: UserRole.MR } })
  })

  it('captures a typed ApiError on failure', async () => {
    const apiError = new ApiError({ code: 'FORBIDDEN', message: 'denied' }, 403)
    const tracking = useTracking(makeOptions({ apiClient: makeFailingApiClient(apiError) }))

    await expect(tracking.fetchPositions()).rejects.toBe(apiError)
    expect(tracking.error.value).toBe(apiError)
    expect(tracking.positions.value).toEqual([])
  })

  it('polls immediately and on each scheduler tick', async () => {
    const { client, get } = makeApiClient([
      makeResponse([makeUser()]),
      makeResponse([makeUser(), makeUser({ user_id: 'u2' })])
    ])
    const { scheduler, run } = makeScheduler()
    const tracking = useTracking(makeOptions({ apiClient: client, scheduler }))

    tracking.startPolling({ role: UserRole.SALESMAN })
    expect(tracking.isPolling.value).toBe(true)
    // Immediate kick-off fetch.
    await Promise.resolve()
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(1)

    // Advance one interval tick.
    run()
    await Promise.resolve()
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenLastCalledWith('/tracking/live-positions', { query: { role: UserRole.SALESMAN } })
  })

  it('stops polling and clears the interval', () => {
    const { client } = makeApiClient()
    const { scheduler, cleared } = makeScheduler()
    const tracking = useTracking(makeOptions({ apiClient: client, scheduler }))

    tracking.startPolling()
    tracking.stopPolling()

    expect(tracking.isPolling.value).toBe(false)
    expect(cleared()).toBe(true)
  })

  it('keeps polling alive when a single tick fails', async () => {
    const tracking = useTracking(
      makeOptions({ apiClient: makeFailingApiClient(new ApiError({ code: 'X', message: 'x' }, 0)) })
    )
    const { scheduler, run } = makeScheduler()
    // Re-create with the manual scheduler bound.
    const failing = useTracking(
      makeOptions({
        apiClient: makeFailingApiClient(new ApiError({ code: 'X', message: 'x' }, 0)),
        scheduler
      })
    )

    failing.startPolling()
    await Promise.resolve()
    await Promise.resolve()
    // The loop remains active despite the rejected fetch.
    expect(failing.isPolling.value).toBe(true)
    expect(() => run()).not.toThrow()

    // The standalone instance's error surfaced too.
    await expect(tracking.fetchPositions()).rejects.toBeInstanceOf(ApiError)
  })
})
