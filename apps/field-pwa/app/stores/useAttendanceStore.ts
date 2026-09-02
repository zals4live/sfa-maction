/**
 * `useAttendanceStore` — today's attendance state + visit lock/unlock gating.
 *
 * The single source of truth for the field user's daily attendance (SALESMAN & MR alike),
 * and the gate that governs whether visit features are reachable. It owns:
 *  - Today's attendance record ({@link AttendanceStoreState.todayAttendance}) — at most one
 *    per user per day — loaded via `GET /attendance/today` with an offline fallback to the
 *    last-known cached record so the app stays usable with no network.
 *  - The lock model: visit features are locked until a valid check-in exists today
 *    ({@link AttendanceStoreApi.isLocked} / {@link AttendanceStoreApi.isUnlocked}). A queued
 *    (offline) check-in reflects an optimistic record so the UI unlocks immediately, while
 *    {@link AttendanceStoreApi.isCheckInPending} makes the not-yet-synced status explicit.
 *  - Conditional check-out: {@link AttendanceStoreApi.canCheckOut} is a client-side gate that
 *    mirrors the backend `CHECKOUT_TOO_EARLY` rule — check-out is only offered once the local
 *    clock reaches a configurable minimum hour (default 16:00). "Now" is injectable so the
 *    gate is deterministic in tests.
 *  - Mutations: {@link AttendanceStoreApi.checkIn} / {@link AttendanceStoreApi.checkOut} flow
 *    through {@link useApiClient}, which performs them online or queues them to the offline
 *    outbox — the store handles both the record response and the `QueuedMutationResult`.
 *
 * Identity (`company_id`, `user_id`, `user_role`) is read from {@link useAuthStore} and
 * forwarded to every mutation (required by `MutationOptions.identity`). Both the API client
 * and the auth store are injectable so tests can drive the store with mocks — mirroring the
 * transport-injection pattern in `useAuthStore`.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { defineStore } from 'pinia'
import type { AttendanceType, MutationType, UserRole } from '@maction/types'
import {
  useApiClient,
  type ApiClientApi,
  type QueuedMutationResult
} from '../composables/useApiClient'
import { useAuthStore } from './useAuthStore'

/** Default minimum local hour (24h) before check-out is offered; mirrors the backend rule. */
export const DEFAULT_MIN_CHECKOUT_HOUR = 16

/** Mutation types recorded in the offline outbox for attendance actions. */
const CHECK_IN_MUTATION: MutationType = 'CHECK_IN'
const CHECK_OUT_MUTATION: MutationType = 'CHECK_OUT'

/**
 * Today's attendance record as returned by the backend attendance API (snake_case).
 *
 * Defined locally because the exported `@maction/types` `Attendance` interface models the
 * persisted DB row (`check_in_at`, `check_in_geom`, ...), which differs from the flatter
 * API response shape the PWA consumes here (`check_in_time`, `check_in_latitude`, ...).
 */
export interface AttendanceRecord {
  id: string
  company_id: string
  user_id: string
  attendance_date: string
  attendance_type: AttendanceType
  check_in_time: string
  check_in_latitude: number
  check_in_longitude: number
  check_in_photo_s3_key: string
  check_in_distance_meters: number | null
  check_out_time: string | null
  check_out_latitude: number | null
  check_out_longitude: number | null
  check_out_photo_s3_key: string | null
  notes: string | null
  created_at: string
}

/** Payload for {@link AttendanceStoreApi.checkIn} (client-captured geo + anti-spoof fields). */
export interface CheckInInput {
  attendance_type: AttendanceType
  latitude: number
  longitude: number
  accuracy: number
  photo_s3_key: string
  notes?: string
  monotonic_delta_ms: number
  client_timestamp: string
}

/** Payload for {@link AttendanceStoreApi.checkOut}; photo is optional per the API contract. */
export interface CheckOutInput {
  latitude: number
  longitude: number
  accuracy: number
  photo_s3_key?: string
  notes?: string
  monotonic_delta_ms: number
  client_timestamp: string
}

/** Options for {@link useAttendanceStore}; all optional so runtime and tests can diverge. */
export interface AttendanceStoreOptions {
  /** Override the API client (tests inject a mock; runtime falls back to {@link useApiClient}). */
  api?: ApiClientApi
  /** Minimum local hour (24h) before check-out unlocks; defaults to {@link DEFAULT_MIN_CHECKOUT_HOUR}. */
  minCheckOutHour?: number
  /** Injectable clock returning the current local hour (0–23); defaults to the wall clock. */
  now?: () => Date
}

/** Backend envelope for attendance reads/writes (`{ data }`). */
interface AttendanceEnvelope {
  data: AttendanceRecord | null
}

/** Narrow a mutation result to the queued (offline) branch. */
function isQueued(result: AttendanceRecord | QueuedMutationResult): result is QueuedMutationResult {
  return (result as QueuedMutationResult).queued === true
}

/** Read the capturing user's identity from the auth store, or throw if unauthenticated. */
function requireIdentity(auth: ReturnType<typeof useAuthStore>): {
  company_id: string
  user_id: string
  user_role: UserRole
} {
  const companyId = auth.companyId
  const userId = auth.userId
  const role = auth.role
  if (!companyId || !userId || !role) {
    throw new Error('Cannot record attendance: no authenticated field user in context.')
  }
  return { company_id: companyId, user_id: userId, user_role: role }
}

export const useAttendanceStore = defineStore('attendance', () => {
  const auth = useAuthStore()

  // The API client and clock are bound once per store instance. Tests can override them by
  // patching the store's injected seams; runtime uses the real client and wall clock.
  let api: ApiClientApi = useApiClient()
  let minCheckOutHour = DEFAULT_MIN_CHECKOUT_HOUR
  let now: () => Date = () => new Date()

  const todayAttendance: Ref<AttendanceRecord | null> = ref(null)
  const loading: Ref<boolean> = ref(false)
  const error: Ref<string | null> = ref(null)
  /** True while a check-in has been optimistically applied but is still queued offline. */
  const isCheckInPending: Ref<boolean> = ref(false)

  /** A valid check-in exists for today (a record with a check-in timestamp). */
  const hasCheckedIn: ComputedRef<boolean> = computed(
    () => todayAttendance.value !== null && todayAttendance.value.check_in_time.length > 0
  )

  /** Today's record has been checked out (a check-out timestamp is present). */
  const hasCheckedOut: ComputedRef<boolean> = computed(
    () => todayAttendance.value?.check_out_time != null
  )

  /** Visit features are locked until a valid check-in exists today. */
  const isLocked: ComputedRef<boolean> = computed(() => !hasCheckedIn.value)

  /** Inverse of {@link isLocked} — visit features are reachable. */
  const isUnlocked: ComputedRef<boolean> = computed(() => !isLocked.value)

  /**
   * Client-side check-out gate: checked in, not yet checked out, and the local clock has
   * reached the minimum hour. Mirrors the backend `CHECKOUT_TOO_EARLY` rule so the UI can
   * disable the button before issuing the request. Pass `nowHour` for deterministic checks.
   */
  function canCheckOut(nowHour: number = now().getHours()): boolean {
    if (!hasCheckedIn.value || hasCheckedOut.value) return false
    return nowHour >= minCheckOutHour
  }

  /** Load today's attendance; falls back to the cached record when offline. */
  async function fetchToday(): Promise<AttendanceRecord | null> {
    loading.value = true
    error.value = null
    try {
      const response = await api.get<AttendanceEnvelope>('/attendance/today', {
        offlineFallback: () => ({ data: todayAttendance.value })
      })
      todayAttendance.value = response?.data ?? null
      return todayAttendance.value
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load attendance.'
      return todayAttendance.value
    } finally {
      loading.value = false
    }
  }

  /** Build the optimistic record applied when a check-in is queued offline. */
  function buildOptimisticCheckIn(input: CheckInInput, id: string): AttendanceRecord {
    const identity = requireIdentity(auth)
    return {
      id,
      company_id: identity.company_id,
      user_id: identity.user_id,
      attendance_date: input.client_timestamp.slice(0, 10),
      attendance_type: input.attendance_type,
      check_in_time: input.client_timestamp,
      check_in_latitude: input.latitude,
      check_in_longitude: input.longitude,
      check_in_photo_s3_key: input.photo_s3_key,
      check_in_distance_meters: null,
      check_out_time: null,
      check_out_latitude: null,
      check_out_longitude: null,
      check_out_photo_s3_key: null,
      notes: input.notes ?? null,
      created_at: input.client_timestamp
    }
  }

  /**
   * Check in for today. Online: sets the returned record. Offline (queued): applies an
   * optimistic record so visit features unlock immediately and flags {@link isCheckInPending}.
   */
  async function checkIn(input: CheckInInput): Promise<AttendanceRecord | QueuedMutationResult> {
    error.value = null
    const identity = requireIdentity(auth)
    const result = await api.post<AttendanceRecord>('/attendance/check-in', {
      identity,
      mutationType: CHECK_IN_MUTATION,
      body: { ...input },
      monoDeltaMs: input.monotonic_delta_ms
    })
    if (isQueued(result)) {
      todayAttendance.value = buildOptimisticCheckIn(input, result.mutationId)
      isCheckInPending.value = true
      return result
    }
    todayAttendance.value = result
    isCheckInPending.value = false
    return result
  }

  /** Merge check-out fields from a queued input onto the existing today record. */
  function applyOptimisticCheckOut(input: CheckOutInput): void {
    if (!todayAttendance.value) return
    todayAttendance.value = {
      ...todayAttendance.value,
      check_out_time: input.client_timestamp,
      check_out_latitude: input.latitude,
      check_out_longitude: input.longitude,
      check_out_photo_s3_key: input.photo_s3_key ?? null,
      notes: input.notes ?? todayAttendance.value.notes
    }
  }

  /**
   * Check out of today's attendance. Online: replaces the record with the server response.
   * Offline (queued): optimistically stamps the check-out fields onto the current record.
   */
  async function checkOut(input: CheckOutInput): Promise<AttendanceRecord | QueuedMutationResult> {
    error.value = null
    const identity = requireIdentity(auth)
    const result = await api.post<AttendanceRecord>('/attendance/check-out', {
      identity,
      mutationType: CHECK_OUT_MUTATION,
      body: { ...input },
      monoDeltaMs: input.monotonic_delta_ms
    })
    if (isQueued(result)) {
      applyOptimisticCheckOut(input)
      return result
    }
    todayAttendance.value = result
    return result
  }

  /** Clear all attendance state (e.g. on logout or tenant switch). */
  function reset(): void {
    todayAttendance.value = null
    loading.value = false
    error.value = null
    isCheckInPending.value = false
  }

  /** Test/config seam: replace the injected API client, clock, and min check-out hour. */
  function configure(options: AttendanceStoreOptions): void {
    if (options.api) api = options.api
    if (options.now) now = options.now
    if (typeof options.minCheckOutHour === 'number') minCheckOutHour = options.minCheckOutHour
  }

  return {
    todayAttendance,
    loading,
    error,
    isCheckInPending,
    hasCheckedIn,
    hasCheckedOut,
    isLocked,
    isUnlocked,
    canCheckOut,
    fetchToday,
    checkIn,
    checkOut,
    reset,
    configure
  }
})
