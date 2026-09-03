import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClientApi } from '../useApiClient'
import {
  useDoctors,
  type AssignmentListResponse,
  type CreateAssignmentInput,
  type DoctorAssignmentResponse,
  type DoctorProfileResponse,
  type UpdateAssignmentInput
} from '../useDoctors'

/** Build a single assignment fixture, overriding fields per test. */
function makeAssignment(
  overrides: Partial<DoctorAssignmentResponse> = {}
): DoctorAssignmentResponse {
  return {
    id: 'a1',
    doctor_customer_id: 'd1',
    outlet_customer_id: 'o1',
    room_or_department: 'Poli Umum',
    is_primary_practice: true,
    practice_days: 'Senin, Rabu',
    practice_hours_start: '08:00',
    practice_hours_end: '12:00',
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    outlet: {
      id: 'o1',
      name: 'RS Sehat',
      address: null,
      city: 'Jakarta',
      latitude: -6.2,
      longitude: 106.8
    },
    ...overrides
  }
}

/** Build an assignment-list envelope. */
function makeListResponse(): AssignmentListResponse {
  return { data: [makeAssignment()] }
}

/** Build a doctor profile fixture. */
function makeProfile(overrides: Partial<DoctorProfileResponse> = {}): DoctorProfileResponse {
  return {
    id: 'p1',
    customer_id: 'd1',
    sip_str_number: 'SIP-123',
    specialization: 'Penyakit Dalam',
    sub_specialization: null,
    practice_schedule: null,
    notes: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides
  }
}

/**
 * API client stub with independently observable verbs. Each verb resolves a matching fixture
 * so method-specific endpoint/param assertions stay isolated.
 */
function makeApiClient(): {
  client: ApiClientApi
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () => makeListResponse())
  const post = vi.fn(async () => ({ data: makeAssignment() }))
  const patch = vi.fn(async () => ({ data: makeAssignment() }))
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

describe('useDoctors', () => {
  it('lists doctors with filters forwarded as query params', async () => {
    const { client, get } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    await doctors.listDoctors({ page: 2, search: 'budi', specialization: 'anak', is_active: true })

    expect(get).toHaveBeenCalledWith('/doctors', {
      query: { page: 2, search: 'budi', specialization: 'anak', is_active: true }
    })
    expect(doctors.error.value).toBeNull()
  })

  it('fetches a single doctor by id', async () => {
    const { client, get } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    await doctors.getDoctor('d1')

    expect(get).toHaveBeenCalledWith('/doctors/d1')
  })

  it('upserts a doctor profile via PATCH to the profile path', async () => {
    const { client, patch } = makeApiClient()
    patch.mockResolvedValueOnce({ data: makeProfile() })
    const doctors = useDoctors({ apiClient: client })

    await doctors.updateProfile('d1', { specialization: 'Anak', sip_str_number: 'SIP-9' })

    expect(patch).toHaveBeenCalledWith('/doctors/d1/profile', {
      body: { specialization: 'Anak', sip_str_number: 'SIP-9' }
    })
  })

  it('requests the assignments endpoint with the doctor id', async () => {
    const { client, get } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    const result = await doctors.listAssignments('d1')

    expect(get).toHaveBeenCalledWith('/doctors/d1/assignments')
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.outlet?.name).toBe('RS Sehat')
  })

  it('creates an assignment via POST to the assignments path', async () => {
    const { client, post } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    const input: CreateAssignmentInput = {
      outlet_customer_id: 'o1',
      room_or_department: 'Poli Anak',
      is_primary_practice: true,
      is_active: true
    }
    await doctors.createAssignment('d1', input)

    expect(post).toHaveBeenCalledWith('/doctors/d1/assignments', { body: input })
  })

  it('updates an assignment via PATCH to the assignment id path', async () => {
    const { client, patch } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    const input: UpdateAssignmentInput = { room_or_department: 'Poli Baru', is_active: false }
    await doctors.updateAssignment('d1', 'a1', input)

    expect(patch).toHaveBeenCalledWith('/doctors/d1/assignments/a1', { body: input })
  })

  it('soft-deletes an assignment via DELETE to the assignment id path', async () => {
    const { client, delete: del } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    const response = await doctors.deleteAssignment('d1', 'a1')

    expect(del).toHaveBeenCalledWith('/doctors/d1/assignments/a1')
    expect(response.data.success).toBe(true)
  })

  it('toggles isLoading around a successful request and clears error', async () => {
    const { client } = makeApiClient()
    const doctors = useDoctors({ apiClient: client })

    const promise = doctors.listAssignments('d1')
    expect(doctors.isLoading.value).toBe(true)
    await promise

    expect(doctors.isLoading.value).toBe(false)
    expect(doctors.error.value).toBeNull()
  })

  it('captures and rethrows a typed ApiError on failure', async () => {
    const apiError = new ApiError({ code: 'DOCTOR_NOT_FOUND', message: 'missing' }, 404)
    const doctors = useDoctors({ apiClient: makeFailingApiClient(apiError) })

    await expect(doctors.listAssignments('d1')).rejects.toBe(apiError)
    expect(doctors.error.value).toBe(apiError)
    expect(doctors.isLoading.value).toBe(false)
  })

  it('wraps a non-ApiError rejection into a REQUEST_FAILED ApiError', async () => {
    const doctors = useDoctors({ apiClient: makeFailingApiClient(new Error('boom')) })

    await expect(doctors.createAssignment('d1', { outlet_customer_id: 'o1' }))
      .rejects.toBeInstanceOf(ApiError)
    expect(doctors.error.value?.code).toBe('REQUEST_FAILED')
  })
})
