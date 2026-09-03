/**
 * `useCustomers` — customer master-data CRUD for the Web Portal (admin, SSR).
 *
 * The single abstraction the `/admin/customers` page uses to read and mutate the backend
 * `/customers/*` endpoints (see services/api-server/src/modules/customer/routes.ts). Unlike
 * {@link useReporting}, this composable is deliberately lean — no cache-aside layer, because
 * customer records are mutable master data where a stale list after a create/edit/delete
 * would be misleading. It owns:
 *  - Typed fetch/mutation methods, one per endpoint: {@link UseCustomersApi.listCustomers},
 *    getCustomer, createCustomer, updateCustomer, deleteCustomer — each taking a typed query
 *    or body and returning the typed response envelope.
 *  - Body normalization for the create/update contract asymmetry: the API returns flat
 *    `latitude`/`longitude`, but the write body nests them under `location: { latitude,
 *    longitude }`. {@link buildCustomerBody} performs that mapping so callers pass flat
 *    coordinates and never wrestle with the nesting.
 *  - Reactive `isLoading` / `error` refs so the page renders spinners and error banners
 *    without a try/catch at every call site.
 *
 * Testability mirrors the sibling composables (useApiClient, useReporting, useTracking): the
 * API client is injectable via an options object (tests supply a mock), runtime falls back to
 * {@link useApiClient}, and nothing throws outside a Nuxt runtime.
 */
import { ref, type Ref } from 'vue'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

/** Customer type discriminator — mirrors the backend `customer_type_enum` contract. */
export type CustomerTypeValue = 'OUTLET' | 'DOCTOR' | 'COMMUNITY' | 'EVENT'

/** `GET /customers` query params (mirrors ListCustomersQuery on the backend). */
export interface ListCustomersQuery {
  page?: number
  limit?: number
  /** Free-text match against name, ERP code, or city. */
  search?: string
  customer_type?: CustomerTypeValue
  is_active?: boolean
  /** Scope to a single sales office (uuid). */
  soffice_id?: string
  city?: string
}

/** A single customer record as returned by the list/mutation endpoints (flat coordinates). */
export interface CustomerResponse {
  id: string
  company_id: string
  soffice_id: string
  customer_type: CustomerTypeValue
  erp_customer_code: string | null
  name: string
  customer_group: string | null
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  credit_limit: number | null
  credit_term_days: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Doctor profile block nested in the detail response. */
export interface DoctorProfileResponse {
  id: string
  sip_str_number: string | null
  specialization: string | null
  sub_specialization: string | null
  practice_schedule: Record<string, unknown> | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** PIC (person-in-charge) block nested in the detail response. */
export interface PicResponse {
  id: string
  customer_id: string
  pic_name: string
  position_title: string | null
  phone: string | null
  is_primary: boolean
  created_at: string
}

/** `GET /customers/:id` payload — the customer plus its PICs and optional doctor profile. */
export interface CustomerDetailResponse extends CustomerResponse {
  pics: PicResponse[]
  doctor_profile: DoctorProfileResponse | null
}

/** Optional doctor-profile fields accepted when creating/updating a doctor customer. */
export interface DoctorProfileInput {
  sip_str_number?: string | null
  specialization?: string | null
  sub_specialization?: string | null
  practice_schedule?: Record<string, unknown> | null
  notes?: string | null
}

/**
 * Flat, page-friendly shape for create/update. Coordinates are flat here (`latitude`/
 * `longitude`) to match the list/response shape; {@link buildCustomerBody} nests them under
 * `location` before sending, so callers never deal with the API's write-side asymmetry.
 */
export interface CustomerFormInput {
  erp_customer_code?: string | null
  customer_group?: string | null
  address?: string | null
  city?: string | null
  latitude?: number | null
  longitude?: number | null
  credit_limit?: number | null
  credit_term_days?: number | null
  is_active?: boolean
  doctor_profile?: DoctorProfileInput
}

/** Full create payload (flat coordinates) — adds the fields fixed at creation time. */
export interface CreateCustomerInput extends CustomerFormInput {
  customer_type: CustomerTypeValue
  soffice_id: string
  name: string
}

/** Partial update payload (flat coordinates) — name is editable, type/soffice are not. */
export interface UpdateCustomerInput extends CustomerFormInput {
  name?: string
}

/** `GET /customers` response envelope (paginated). */
export interface CustomerListResponse {
  data: CustomerResponse[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** Single-customer mutation/detail envelope. */
export interface CustomerMutationResponse {
  data: CustomerResponse
}

/** `GET /customers/:id` envelope. */
export interface CustomerDetailEnvelope {
  data: CustomerDetailResponse
}

/** `DELETE /customers/:id` envelope (soft delete). */
export interface CustomerDeleteResponse {
  data: { success: true }
}

/** Options for {@link useCustomers}; all optional so runtime and tests can diverge. */
export interface UseCustomersOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
}

/** Public surface returned by {@link useCustomers}. */
export interface UseCustomersApi {
  /** Whether any request is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  /** Fetch a paginated, filtered customer list. */
  listCustomers: (query?: ListCustomersQuery) => Promise<CustomerListResponse>
  /** Fetch a single customer (with PICs and doctor profile). */
  getCustomer: (id: string) => Promise<CustomerDetailEnvelope>
  /** Create a customer (Outlet, Doctor, Community, or Event). */
  createCustomer: (input: CreateCustomerInput) => Promise<CustomerMutationResponse>
  /** Partially update a customer. */
  updateCustomer: (id: string, input: UpdateCustomerInput) => Promise<CustomerMutationResponse>
  /** Soft-delete a customer. */
  deleteCustomer: (id: string) => Promise<CustomerDeleteResponse>
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

/**
 * Map a flat form input to the backend write body. The API nests coordinates under
 * `location`, so a lat/lng pair is folded into `{ location: { latitude, longitude } }`; when
 * either coordinate is absent, `location` is omitted entirely rather than sent as partial.
 */
export function buildCustomerBody<T extends CustomerFormInput>(
  input: T
): Record<string, unknown> {
  const { latitude, longitude, ...rest } = input
  const body: Record<string, unknown> = { ...rest }
  if (latitude !== undefined && latitude !== null
    && longitude !== undefined && longitude !== null) {
    body.location = { latitude, longitude }
  }
  return body
}

export function useCustomers(options: UseCustomersOptions = {}): UseCustomersApi {
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)

  const isLoading = ref<boolean>(false)
  const error = ref<ApiError | null>(null)

  /**
   * Run a request while managing the reactive `isLoading` / `error` refs. Centralizes the
   * try/finally so each public method stays a one-liner over the transport.
   */
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

  function listCustomers(query: ListCustomersQuery = {}): Promise<CustomerListResponse> {
    return run(() => apiClient.get<CustomerListResponse>('/customers', {
      query: query as Record<string, unknown>
    }))
  }

  function getCustomer(id: string): Promise<CustomerDetailEnvelope> {
    return run(() => apiClient.get<CustomerDetailEnvelope>(`/customers/${id}`))
  }

  function createCustomer(input: CreateCustomerInput): Promise<CustomerMutationResponse> {
    return run(() => apiClient.post<CustomerMutationResponse>('/customers', {
      body: buildCustomerBody(input)
    }))
  }

  function updateCustomer(
    id: string,
    input: UpdateCustomerInput
  ): Promise<CustomerMutationResponse> {
    return run(() => apiClient.patch<CustomerMutationResponse>(`/customers/${id}`, {
      body: buildCustomerBody(input)
    }))
  }

  function deleteCustomer(id: string): Promise<CustomerDeleteResponse> {
    return run(() => apiClient.delete<CustomerDeleteResponse>(`/customers/${id}`))
  }

  return {
    isLoading,
    error,
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    deleteCustomer
  }
}
