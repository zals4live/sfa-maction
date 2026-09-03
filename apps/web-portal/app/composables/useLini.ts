/**
 * `useLini` — business-line (lini), product-variant (varian), and user-lini assignment
 * reads/writes for the Web Portal (admin, SSR).
 *
 * The single abstraction the `/admin/lini` page uses to manage master data behind the backend
 * lini module (see services/api-server/src/modules/lini/routes.ts), which exposes three
 * resource groups sharing one module:
 *  - `GET/POST/PATCH/DELETE /lini`   — business lines (`master_lini`)
 *  - `GET/POST/PATCH/DELETE /varian` — product variants (`master_varian`)
 *  - `GET/POST/DELETE /users/:userId/lini` — the M:N user→lini assignment junction
 *    (`user_lini_assignments`). Note the POST is a *batch* assign (`{ lini_ids: [...] }`) and
 *    the DELETE targets a single `liniId` under the user, so assignment is add/remove rather
 *    than a full replace.
 *
 * It mirrors the shape and testing pattern of {@link useCustomers} / {@link useDoctors}: no
 * cache-aside layer (master data is mutable and staleness would mislead), one typed method per
 * endpoint, and reactive `isLoading` / `error` refs so pages render spinners and error banners
 * without a try/catch at every call site. The API client is injectable (tests supply a mock),
 * runtime falls back to {@link useApiClient}, and nothing throws outside a Nuxt runtime.
 */
import { ref, type Ref } from 'vue'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

// --- Shared master-data query (lini & varian share the same pagination contract) ---

/** `GET /lini` and `GET /varian` query params (mirrors the backend PaginationQuery). */
export interface ListMasterQuery {
  page?: number
  limit?: number
  /** Free-text match against code or name. */
  search?: string
  is_active?: boolean
}

// --- Lini contracts (mirror LiniResponse on the backend) ---

/** A single business-line record as returned by the list/mutation endpoints. */
export interface LiniResponse {
  id: string
  company_id: string
  code: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** `POST /lini` body (mirrors CreateLiniBody). */
export interface CreateLiniInput {
  code: string
  name: string
  description?: string | null
  is_active?: boolean
}

/** `PATCH /lini/:id` body (mirrors UpdateLiniBody) — partial update. */
export interface UpdateLiniInput {
  code?: string
  name?: string
  description?: string | null
  is_active?: boolean
}

// --- Varian contracts (mirror VarianResponse on the backend) ---

/** A single product-variant record as returned by the list/mutation endpoints. */
export interface VarianResponse {
  id: string
  company_id: string
  code: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** `POST /varian` body (mirrors CreateVarianBody). */
export interface CreateVarianInput {
  code: string
  name: string
  description?: string | null
  is_active?: boolean
}

/** `PATCH /varian/:id` body (mirrors UpdateVarianBody) — partial update. */
export interface UpdateVarianInput {
  code?: string
  name?: string
  description?: string | null
  is_active?: boolean
}

// --- User-lini assignment contracts (mirror UserLiniAssignmentResponse) ---

/** `GET /users/:userId/lini` query params. */
export interface ListUserLiniQuery {
  is_active?: boolean
}

/** A single user→lini assignment, joined with the lini's code and name. */
export interface UserLiniAssignmentResponse {
  id: string
  company_id: string
  user_id: string
  lini_id: string
  lini_code: string
  lini_name: string
  is_active: boolean
  created_at: string
}

// --- Response envelopes ---

/** Paginated master-data list envelope (shared by lini and varian). */
export interface MasterListResponse<T> {
  data: T[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** `GET /lini` paginated envelope. */
export type LiniListResponse = MasterListResponse<LiniResponse>
/** `GET /varian` paginated envelope. */
export type VarianListResponse = MasterListResponse<VarianResponse>

/** Single-lini mutation/detail envelope. */
export interface LiniMutationResponse {
  data: LiniResponse
}

/** Single-varian mutation/detail envelope. */
export interface VarianMutationResponse {
  data: VarianResponse
}

/** `GET /users/:userId/lini` envelope (not paginated). */
export interface UserLiniListResponse {
  data: UserLiniAssignmentResponse[]
}

/** `POST /users/:userId/lini` batch-assign envelope (returns newly created assignments). */
export interface UserLiniAssignResponse {
  data: UserLiniAssignmentResponse[]
}

/** Soft/physical delete envelope (shared across lini, varian, and assignment removal). */
export interface DeleteResponse {
  data: { success: true }
}

/** Options for {@link useLini}; all optional so runtime and tests can diverge. */
export interface UseLiniOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
}

/** Public surface returned by {@link useLini}. */
export interface UseLiniApi {
  /** Whether any request is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  // Lini CRUD
  listLini: (query?: ListMasterQuery) => Promise<LiniListResponse>
  createLini: (input: CreateLiniInput) => Promise<LiniMutationResponse>
  updateLini: (id: string, input: UpdateLiniInput) => Promise<LiniMutationResponse>
  deleteLini: (id: string) => Promise<DeleteResponse>
  // Varian CRUD
  listVarian: (query?: ListMasterQuery) => Promise<VarianListResponse>
  createVarian: (input: CreateVarianInput) => Promise<VarianMutationResponse>
  updateVarian: (id: string, input: UpdateVarianInput) => Promise<VarianMutationResponse>
  deleteVarian: (id: string) => Promise<DeleteResponse>
  // User-lini assignment (M:N)
  listUserLini: (userId: string, query?: ListUserLiniQuery) => Promise<UserLiniListResponse>
  assignUserLini: (userId: string, liniIds: string[]) => Promise<UserLiniAssignResponse>
  removeUserLini: (userId: string, liniId: string) => Promise<DeleteResponse>
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useLini(options: UseLiniOptions = {}): UseLiniApi {
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

  // --- Lini ---

  function listLini(query: ListMasterQuery = {}): Promise<LiniListResponse> {
    return run(() => apiClient.get<LiniListResponse>('/lini', {
      query: query as Record<string, unknown>
    }))
  }

  function createLini(input: CreateLiniInput): Promise<LiniMutationResponse> {
    return run(() => apiClient.post<LiniMutationResponse>('/lini', {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function updateLini(id: string, input: UpdateLiniInput): Promise<LiniMutationResponse> {
    return run(() => apiClient.patch<LiniMutationResponse>(`/lini/${id}`, {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function deleteLini(id: string): Promise<DeleteResponse> {
    return run(() => apiClient.delete<DeleteResponse>(`/lini/${id}`))
  }

  // --- Varian ---

  function listVarian(query: ListMasterQuery = {}): Promise<VarianListResponse> {
    return run(() => apiClient.get<VarianListResponse>('/varian', {
      query: query as Record<string, unknown>
    }))
  }

  function createVarian(input: CreateVarianInput): Promise<VarianMutationResponse> {
    return run(() => apiClient.post<VarianMutationResponse>('/varian', {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function updateVarian(id: string, input: UpdateVarianInput): Promise<VarianMutationResponse> {
    return run(() => apiClient.patch<VarianMutationResponse>(`/varian/${id}`, {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function deleteVarian(id: string): Promise<DeleteResponse> {
    return run(() => apiClient.delete<DeleteResponse>(`/varian/${id}`))
  }

  // --- User-lini assignment (M:N) ---

  function listUserLini(
    userId: string,
    query: ListUserLiniQuery = {}
  ): Promise<UserLiniListResponse> {
    return run(() => apiClient.get<UserLiniListResponse>(`/users/${userId}/lini`, {
      query: query as Record<string, unknown>
    }))
  }

  function assignUserLini(userId: string, liniIds: string[]): Promise<UserLiniAssignResponse> {
    return run(() => apiClient.post<UserLiniAssignResponse>(`/users/${userId}/lini`, {
      body: { lini_ids: liniIds }
    }))
  }

  function removeUserLini(userId: string, liniId: string): Promise<DeleteResponse> {
    return run(() => apiClient.delete<DeleteResponse>(`/users/${userId}/lini/${liniId}`))
  }

  return {
    isLoading,
    error,
    listLini,
    createLini,
    updateLini,
    deleteLini,
    listVarian,
    createVarian,
    updateVarian,
    deleteVarian,
    listUserLini,
    assignUserLini,
    removeUserLini
  }
}
