import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { AttendanceType, UserRole } from '@maction/types'
import type {
  ApiClientApi,
  GetOptions,
  MutationOptions,
  QueuedMutationResult
} from '../../composables/useApiClient'
import { useAuthStore, type AuthTokenClaims } from '../useAuthStore'
import {
  DEFAULT_MIN_CHECKOUT_HOUR,
  useAttendanceStore,
  type AttendanceRecord,
  type CheckInInput,
  type CheckOutInput
} from '../useAttendanceStore'

/** Base64URL-encode a UTF-8 string (test-side JWT builder). */
function base64Url(input: string): string {
  const base64 = Buffer.from(input, 'utf-8').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build a valid JWT carrying the given claims (defaults to a SALESMAN). */
function makeToken(claims: Partial<AuthTokenClaims> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const payload: AuthTokenClaims = {
    user_id: 'user-1',
    company_id: 'company-a',
    soffice_id: 'soffice-1',
    role_label: UserRole.SALESMAN,
    lini_ids: ['lini-1'],
    iat: nowSec,
    exp: nowSec + 3600,
    ...claims
  }
  return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify(payload))}.sig`
}

/** In-memory localStorage shim so the auth store can persist a session. */
function installStorage(): { store: Map<string, string>, restore: () => void } {
  const store = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k)
    }
  })
  return {
    store,
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  }
}

/** A fully-populated online attendance record used across the reader/writer tests. */
function makeRecord(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: 'att-1',
    company_id: 'company-a',
    user_id: 'user-1',
    attendance_date: '2024-01-15',
    attendance_type: AttendanceType.OFFICE,
    check_in_time: '2024-01-15T08:00:00.000Z',
    check_in_latitude: -6.2,
    check_in_longitude: 106.8,
    check_in_photo_s3_key: 'company-a/photos/2024/checkin.jpg',
    check_in_distance_meters: 12,
    check_out_time: null,
    check_out_latitude: null,
    check_out_longitude: null,
    check_out_photo_s3_key: null,
    notes: null,
    created_at: '2024-01-15T08:00:00.000Z',
    ...overrides
  }
}

const CHECK_IN_INPUT: CheckInInput = {
  attendance_type: AttendanceType.OFFICE,
  latitude: -6.2,
  longitude: 106.8,
  accuracy: 10,
  photo_s3_key: 'company-a/photos/2024/checkin.jpg',
  monotonic_delta_ms: 5,
  client_timestamp: '2024-01-15T08:00:00.000Z'
}

const CHECK_OUT_INPUT: CheckOutInput = {
  latitude: -6.2,
  longitude: 106.8,
  accuracy: 10,
  monotonic_delta_ms: 5,
  client_timestamp: '2024-01-15T17:00:00.000Z'
}

/** A stubbed API client that records mutation calls and returns queued/online results. */
interface MockApi extends ApiClientApi {
  getMock: ReturnType<typeof vi.fn>
  postMock: ReturnType<typeof vi.fn>
}

/** Build a mock ApiClientApi. `getResult`/`postResult` drive read + mutation responses. */
function makeApi(config: {
  getResult?: unknown
  getImpl?: (path: string, options?: GetOptions<unknown>) => Promise<unknown>
  postResult?: AttendanceRecord | QueuedMutationResult
} = {}): MockApi {
  const getMock = vi.fn(async (path: string, options?: GetOptions<unknown>) => {
    if (config.getImpl) return config.getImpl(path, options)
    return config.getResult
  })
  const postMock = vi.fn(async (_path: string, _options: MutationOptions) => config.postResult)
  const connectivity = { value: 'ONLINE' as const }
  return {
    connectivity: connectivity as unknown as ApiClientApi['connectivity'],
    get: getMock as unknown as ApiClientApi['get'],
    post: postMock as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete'],
    getMock,
    postMock
  }
}

/** Authenticate the auth store so the attendance store can read identity. */
async function authenticate(role: UserRole = UserRole.SALESMAN): Promise<void> {
  vi.stubGlobal('$fetch', vi.fn(async () => ({ data: { token: makeToken({ role_label: role }) } })))
  const auth = useAuthStore()
  await auth.login({ email: 'a@b.com', password: 'x' })
}

describe('useAttendanceStore', () => {
  let storage: ReturnType<typeof installStorage>

  beforeEach(() => {
    setActivePinia(createPinia())
    storage = installStorage()
  })

  afterEach(() => {
    storage.restore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('lock/unlock gating', () => {
    it('locks visit features when no check-in exists today', () => {
      const store = useAttendanceStore()
      store.configure({ api: makeApi() })

      expect(store.hasCheckedIn).toBe(false)
      expect(store.isLocked).toBe(true)
      expect(store.isUnlocked).toBe(false)
    })

    it('unlocks visit features after a successful check-in', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: makeRecord() }) })

      await store.checkIn(CHECK_IN_INPUT)

      expect(store.hasCheckedIn).toBe(true)
      expect(store.isLocked).toBe(false)
      expect(store.isUnlocked).toBe(true)
      expect(store.isCheckInPending).toBe(false)
    })

    it('applies equally to the MR role', async () => {
      await authenticate(UserRole.MR)
      const store = useAttendanceStore()
      const api = makeApi({ postResult: makeRecord() })
      store.configure({ api })

      await store.checkIn(CHECK_IN_INPUT)

      expect(store.isUnlocked).toBe(true)
      const [, options] = api.postMock.mock.calls[0] as [string, MutationOptions]
      expect(options.identity.user_role).toBe(UserRole.MR)
    })
  })

  describe('hasCheckedOut detection', () => {
    it('is false with only a check-in and true once a check-out time is present', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: makeRecord() }) })

      await store.checkIn(CHECK_IN_INPUT)
      expect(store.hasCheckedOut).toBe(false)

      store.configure({
        api: makeApi({ postResult: makeRecord({ check_out_time: '2024-01-15T17:00:00.000Z' }) })
      })
      await store.checkOut(CHECK_OUT_INPUT)
      expect(store.hasCheckedOut).toBe(true)
    })
  })

  describe('canCheckOut time-gating', () => {
    it('is false before the minimum hour and true at/after it', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: makeRecord() }) })
      await store.checkIn(CHECK_IN_INPUT)

      expect(store.canCheckOut(15)).toBe(false)
      expect(store.canCheckOut(DEFAULT_MIN_CHECKOUT_HOUR)).toBe(true)
      expect(store.canCheckOut(18)).toBe(true)
    })

    it('respects a configured minimum hour and injected clock', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({
        api: makeApi({ postResult: makeRecord() }),
        minCheckOutHour: 20,
        now: () => new Date('2024-01-15T21:30:00')
      })
      await store.checkIn(CHECK_IN_INPUT)

      expect(store.canCheckOut(19)).toBe(false)
      expect(store.canCheckOut()).toBe(true)
    })

    it('is false when not checked in or already checked out', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: makeRecord() }) })
      expect(store.canCheckOut(18)).toBe(false)

      store.configure({
        api: makeApi({ postResult: makeRecord({ check_out_time: '2024-01-15T17:00:00.000Z' }) })
      })
      await store.checkIn(CHECK_IN_INPUT)
      await store.checkOut(CHECK_OUT_INPUT)
      expect(store.canCheckOut(18)).toBe(false)
    })
  })

  describe('fetchToday', () => {
    it('sets todayAttendance from the API response', async () => {
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ getResult: { data: makeRecord() } }) })

      const record = await store.fetchToday()

      expect(record?.id).toBe('att-1')
      expect(store.hasCheckedIn).toBe(true)
    })

    it('falls back to the cached record when offline', async () => {
      const store = useAttendanceStore()
      // Simulate the client resolving via the caller-supplied offlineFallback.
      const api = makeApi({
        getImpl: (_path, options) => Promise.resolve((options as GetOptions<unknown>)?.offlineFallback?.())
      })
      store.configure({ api })
      store.todayAttendance = makeRecord({ id: 'cached-1' })

      const record = await store.fetchToday()

      expect(record?.id).toBe('cached-1')
      expect(store.isUnlocked).toBe(true)
    })
  })

  describe('queued (offline) check-in', () => {
    it('optimistically unlocks and flags the pending state', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: { queued: true, mutationId: 'mut-9' } }) })

      const result = await store.checkIn(CHECK_IN_INPUT)

      expect(result).toEqual({ queued: true, mutationId: 'mut-9' })
      expect(store.hasCheckedIn).toBe(true)
      expect(store.isUnlocked).toBe(true)
      expect(store.isCheckInPending).toBe(true)
      expect(store.todayAttendance?.id).toBe('mut-9')
      expect(store.todayAttendance?.check_out_time).toBeNull()
    })

    it('optimistically stamps check-out fields when queued offline', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: makeRecord() }) })
      await store.checkIn(CHECK_IN_INPUT)

      store.configure({ api: makeApi({ postResult: { queued: true, mutationId: 'mut-out' } }) })
      await store.checkOut(CHECK_OUT_INPUT)

      expect(store.hasCheckedOut).toBe(true)
      expect(store.todayAttendance?.check_out_time).toBe(CHECK_OUT_INPUT.client_timestamp)
    })
  })

  describe('reset', () => {
    it('clears all attendance state', async () => {
      await authenticate()
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: { queued: true, mutationId: 'm' } }) })
      await store.checkIn(CHECK_IN_INPUT)
      expect(store.isUnlocked).toBe(true)

      store.reset()

      expect(store.todayAttendance).toBeNull()
      expect(store.isLocked).toBe(true)
      expect(store.isCheckInPending).toBe(false)
    })
  })

  describe('identity forwarding', () => {
    it('throws when no authenticated user is in context', async () => {
      const store = useAttendanceStore()
      store.configure({ api: makeApi({ postResult: makeRecord() }) })
      await expect(store.checkIn(CHECK_IN_INPUT)).rejects.toThrow()
    })

    it('forwards company/user/role identity to the mutation', async () => {
      await authenticate()
      const store = useAttendanceStore()
      const api = makeApi({ postResult: makeRecord() })
      store.configure({ api })

      await store.checkIn(CHECK_IN_INPUT)

      const [path, options] = api.postMock.mock.calls[0] as [string, MutationOptions]
      expect(path).toBe('/attendance/check-in')
      expect(options.identity).toEqual({
        company_id: 'company-a',
        user_id: 'user-1',
        user_role: UserRole.SALESMAN
      })
      expect(options.mutationType).toBe('CHECK_IN')
    })
  })
})
