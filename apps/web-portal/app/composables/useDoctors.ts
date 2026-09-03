/**
 * `useDoctors` — doctor master-data + outlet-affiliation reads/writes for the Web Portal.
 *
 * The single abstraction over the backend doctor module (see
 * services/api-server/src/modules/doctor/routes.ts), which owns both doctor listing/detail and
 * the doctor→outlet assignment matrix (`doctor_outlet_assignments`). Doctors are
 * `master_customer` rows with `customer_type = 'DOCTOR'`, but the specialization profile and
 * practice-outlet affiliations live on this module rather than the generic customer module —
 * so the doctor management screen and the Customer 360 view both come through here.
 *
 * It mirrors the shape and testing pattern of {@link useCustomers}: no cache-aside layer
 * (doctor + assignment records are mutable master data where staleness would mislead), one
 * typed method per endpoint, and reactive `isLoading` / `error` refs so pages render spinners
 * and error banners without a try/catch at every call site. The API client is injectable
 * (tests supply a mock), runtime falls back to {@link useApiClient}, and nothing throws
 * outside a Nuxt runtime.
 */
import { ref, type Ref } from 'vue'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

/** Outlet summary embedded in each assignment (mirrors the backend OutletSummary schema). */
export interface AssignmentOutletSummary {
  id: string
  name: string
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
}

/** Doctor specialization profile (mirrors the backend DoctorProfileResponse schema). */
export interface DoctorProfileResponse {
  id: string
  customer_id: string
  sip_str_number: string | null
  specialization: string | null
  sub_specialization: string | null
  practice_schedule: Record<string, unknown> | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** A doctor row in the paginated list (mirrors the backend DoctorListItemResponse schema). */
export interface DoctorListItem {
  id: string
  company_id: string
  soffice_id: string
  name: string
  erp_customer_code: string | null
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  is_active: boolean
  created_at: string
  updated_at: string
  doctor_profile: DoctorProfileResponse | null
}

/**
 * A single doctor-outlet affiliation as returned by `GET /doctors/:id/assignments`, with the
 * affiliated practice outlet embedded (mirrors DoctorOutletAssignmentResponse on the backend).
 */
export interface DoctorAssignmentResponse {
  id: string
  doctor_customer_id: string
  outlet_customer_id: string
  room_or_department: string | null
  is_primary_practice: boolean
  practice_days: string | null
  practice_hours_start: string | null
  practice_hours_end: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  outlet?: AssignmentOutletSummary
}

/** Doctor detail — the doctor row plus its profile and full assignment matrix. */
export interface DoctorDetailResponse extends DoctorListItem {
  assignments: DoctorAssignmentResponse[]
}

/** `GET /doctors` query params (mirrors ListDoctorsQuery on the backend). */
export interface ListDoctorsQuery {
  page?: number
  limit?: number
  /** Free-text match against doctor name or SIP/STR number. */
  search?: string
  /** Filter by specialization (partial match). */
  specialization?: string
  is_active?: boolean
  /** Scope to a single sales office (uuid). */
  soffice_id?: string
}

/** Editable doctor-profile fields (mirrors UpdateDoctorProfileBody on the backend). */
export interface DoctorProfileInput {
  sip_str_number?: string | null
  specialization?: string | null
  sub_specialization?: string | null
  practice_schedule?: Record<string, unknown> | null
  notes?: string | null
}

/** `POST /doctors/:id/assignments` body (mirrors CreateAssignmentBody on the backend). */
export interface CreateAssignmentInput {
  outlet_customer_id: string
  room_or_department?: string | null
  is_primary_practice?: boolean
  practice_days?: string | null
  /** `HH:MM` format. */
  practice_hours_start?: string | null
  /** `HH:MM` format. */
  practice_hours_end?: string | null
  is_active?: boolean
}

/**
 * `PATCH /doctors/:id/assignments/:assignmentId` body (mirrors UpdateAssignmentBody). The
 * outlet is fixed at creation time, so it is intentionally absent from the update contract.
 */
export interface UpdateAssignmentInput {
  room_or_department?: string | null
  is_primary_practice?: boolean
  practice_days?: string | null
  practice_hours_start?: string | null
  practice_hours_end?: string | null
  is_active?: boolean
}

/** `GET /doctors` response envelope (paginated). */
export interface DoctorListResponse {
  data: DoctorListItem[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** `GET /doctors/:id` envelope. */
export interface DoctorDetailEnvelope {
  data: DoctorDetailResponse
}

/** `PATCH /doctors/:id/profile` envelope. */
export interface DoctorProfileEnvelope {
  data: DoctorProfileResponse
}

/** `GET /doctors/:id/assignments` envelope. */
export interface AssignmentListResponse {
  data: DoctorAssignmentResponse[]
}

/** Assignment create/update mutation envelope. */
export interface AssignmentMutationResponse {
  data: DoctorAssignmentResponse
}

/** `DELETE /doctors/:id/assignments/:assignmentId` envelope (soft delete). */
export interface AssignmentDeleteResponse {
  data: { success: true }
}

/** Options for {@link useDoctors}; all optional so runtime and tests can diverge. */
export interface UseDoctorsOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
}

/** Public surface returned by {@link useDoctors}. */
export interface UseDoctorsApi {
  /** Whether any request is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  /** Fetch a paginated, filtered doctor list. */
  listDoctors: (query?: ListDoctorsQuery) => Promise<DoctorListResponse>
  /** Fetch a single doctor (profile + assignment matrix). */
  getDoctor: (id: string) => Promise<DoctorDetailEnvelope>
  /** Update (upsert) a doctor's specialization profile. */
  updateProfile: (id: string, input: DoctorProfileInput) => Promise<DoctorProfileEnvelope>
  /** List a doctor's active practice-outlet affiliations. */
  listAssignments: (doctorId: string) => Promise<AssignmentListResponse>
  /** Add a practice-outlet affiliation to a doctor. */
  createAssignment: (
    doctorId: string,
    input: CreateAssignmentInput
  ) => Promise<AssignmentMutationResponse>
  /** Partially update an existing affiliation. */
  updateAssignment: (
    doctorId: string,
    assignmentId: string,
    input: UpdateAssignmentInput
  ) => Promise<AssignmentMutationResponse>
  /** Soft-delete an affiliation. */
  deleteAssignment: (doctorId: string, assignmentId: string) => Promise<AssignmentDeleteResponse>
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useDoctors(options: UseDoctorsOptions = {}): UseDoctorsApi {
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)

  const isLoading = ref<boolean>(false)
  const error = ref<ApiError | null>(null)

  /** Run a request while managing the reactive `isLoading` / `error` refs. */
  async function run<T>(op: () => Promise<T>): Promise<T> {
    isLoading.value = true
    error.value = null
    try {
      return await op()
    } catch (err) {
      const apiError = toApiError(err)
      error.value = apiError
      throw apiError
    } finally {
      isLoading.value = false
    }
  }

  function listDoctors(query: ListDoctorsQuery = {}): Promise<DoctorListResponse> {
    return run(() => apiClient.get<DoctorListResponse>('/doctors', {
      query: query as Record<string, unknown>
    }))
  }

  function getDoctor(id: string): Promise<DoctorDetailEnvelope> {
    return run(() => apiClient.get<DoctorDetailEnvelope>(`/doctors/${id}`))
  }

  function updateProfile(id: string, input: DoctorProfileInput): Promise<DoctorProfileEnvelope> {
    return run(() => apiClient.patch<DoctorProfileEnvelope>(`/doctors/${id}/profile`, {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function listAssignments(doctorId: string): Promise<AssignmentListResponse> {
    return run(() => apiClient.get<AssignmentListResponse>(`/doctors/${doctorId}/assignments`))
  }

  function createAssignment(
    doctorId: string,
    input: CreateAssignmentInput
  ): Promise<AssignmentMutationResponse> {
    return run(() => apiClient.post<AssignmentMutationResponse>(
      `/doctors/${doctorId}/assignments`,
      { body: input as unknown as Record<string, unknown> }
    ))
  }

  function updateAssignment(
    doctorId: string,
    assignmentId: string,
    input: UpdateAssignmentInput
  ): Promise<AssignmentMutationResponse> {
    return run(() => apiClient.patch<AssignmentMutationResponse>(
      `/doctors/${doctorId}/assignments/${assignmentId}`,
      { body: input as unknown as Record<string, unknown> }
    ))
  }

  function deleteAssignment(
    doctorId: string,
    assignmentId: string
  ): Promise<AssignmentDeleteResponse> {
    return run(() => apiClient.delete<AssignmentDeleteResponse>(
      `/doctors/${doctorId}/assignments/${assignmentId}`
    ))
  }

  return {
    isLoading,
    error,
    listDoctors,
    getDoctor,
    updateProfile,
    listAssignments,
    createAssignment,
    updateAssignment,
    deleteAssignment
  }
}
