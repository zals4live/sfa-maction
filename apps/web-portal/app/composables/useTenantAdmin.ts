/**
 * `useTenantAdmin` — cross-tenant company (tenant) CRUD for the Web Portal, SUPER_ADMIN only.
 *
 * The single abstraction the `/admin/super/tenants` page uses to govern the `companies`
 * table behind the backend tenant module (see services/api-server/src/modules/tenant/routes.ts),
 * which is itself gated to `SUPER_ADMIN` by the backend role guard:
 *  - `GET  /tenants`                 — paginated + searchable company list
 *  - `POST /tenants`                 — provision a new tenant (branding + optional ERP fields)
 *  - `PATCH /tenants/:id`            — partial update (code, name, branding, checkout hour)
 *  - `PATCH /tenants/:id/deactivate` — kill-switch: deactivate + invalidate Redis sessions
 *  - `PUT  /tenants/:id/erp-config`  — replace the ERP gateway configuration
 *
 * It mirrors the shape and testing pattern of {@link useLini} / {@link useCustomers}: no
 * cache-aside layer (tenant governance data is mutable and staleness would mislead), one typed
 * method per endpoint, and reactive `isLoading` / `error` refs so pages render spinners and
 * error banners without a try/catch at every call site. The API client is injectable (tests
 * supply a mock), runtime falls back to {@link useApiClient}, and nothing throws outside a Nuxt
 * runtime.
 *
 * NOTE ON TYPES: the backend `CompanyResponse` carries `checkout_min_hour`, which the shared
 * `@maction/types` `Company` interface does not yet model, so the contracts below intentionally
 * mirror the backend response shape (the source of truth for this page) rather than the shared
 * type.
 */
import { ref, type Ref } from 'vue'
import type { ERPSystemType } from '@maction/types'
import {
  ApiError,
  useApiClient,
  type ApiClientApi,
  type ApiClientOptions
} from './useApiClient'

// --- Response contracts (mirror tenant module CompanyResponse / CompanyListResponse) ---

/** A single tenant company as returned by the list/mutation endpoints. */
export interface TenantResponse {
  id: string
  code: string
  name: string
  is_active: boolean
  logo_s3_key: string | null
  default_tax_rate: number
  geofence_radius_meters: number
  checkout_min_hour: number
  erp_system_type: ERPSystemType | null
  erp_endpoint_url: string | null
  erp_auth_config: Record<string, unknown> | null
  erp_company_code: string | null
  created_at: string
  updated_at: string
}

// --- Request contracts ---

/** `GET /tenants` query params (mirrors ListCompaniesQuery). */
export interface ListTenantsQuery {
  page?: number
  limit?: number
  /** Free-text match against company code or name. */
  search?: string
}

/** `POST /tenants` body (mirrors CreateCompanyBody). */
export interface CreateTenantInput {
  code: string
  name: string
  logo_s3_key?: string | null
  erp_system_type?: ERPSystemType
  erp_endpoint_url?: string | null
  erp_company_code?: string | null
  default_tax_rate?: number
  geofence_radius_meters?: number
  checkout_min_hour?: number
}

/** `PATCH /tenants/:id` body (mirrors UpdateCompanyBody) — partial update. */
export interface UpdateTenantInput {
  code?: string
  name?: string
  logo_s3_key?: string | null
  default_tax_rate?: number
  geofence_radius_meters?: number
  checkout_min_hour?: number
}

/** `PUT /tenants/:id/erp-config` body (mirrors UpdateERPConfigBody). */
export interface UpdateERPConfigInput {
  erp_system_type: ERPSystemType
  erp_endpoint_url: string | null
  erp_auth_config?: Record<string, unknown> | null
  erp_company_code?: string | null
}

// --- Response envelopes ---

/** `GET /tenants` paginated envelope. */
export interface TenantListResponse {
  data: TenantResponse[]
  meta: {
    page: number
    limit: number
    total: number
  }
}

/** Single-tenant mutation/detail envelope (create/update/erp-config). */
export interface TenantMutationResponse {
  data: TenantResponse
}

/** Deactivate (kill-switch) envelope. */
export interface DeactivateTenantResponse {
  data: { success: true }
}

/** Options for {@link useTenantAdmin}; all optional so runtime and tests can diverge. */
export interface UseTenantAdminOptions {
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
}

/** Public surface returned by {@link useTenantAdmin}. */
export interface UseTenantAdminApi {
  /** Whether any request is currently in flight. */
  isLoading: Ref<boolean>
  /** The last request error, or null when the last request succeeded. */
  error: Ref<ApiError | null>
  listTenants: (query?: ListTenantsQuery) => Promise<TenantListResponse>
  createTenant: (input: CreateTenantInput) => Promise<TenantMutationResponse>
  updateTenant: (id: string, input: UpdateTenantInput) => Promise<TenantMutationResponse>
  deactivateTenant: (id: string) => Promise<DeactivateTenantResponse>
  updateERPConfig: (id: string, input: UpdateERPConfigInput) => Promise<TenantMutationResponse>
}

/** Coerce an unknown thrown value into a typed {@link ApiError} for the reactive error ref. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const message = err instanceof Error ? err.message : 'The request could not be completed.'
  return new ApiError({ code: 'REQUEST_FAILED', message }, 0)
}

export function useTenantAdmin(options: UseTenantAdminOptions = {}): UseTenantAdminApi {
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

  function listTenants(query: ListTenantsQuery = {}): Promise<TenantListResponse> {
    return run(() => apiClient.get<TenantListResponse>('/tenants', {
      query: query as Record<string, unknown>
    }))
  }

  function createTenant(input: CreateTenantInput): Promise<TenantMutationResponse> {
    return run(() => apiClient.post<TenantMutationResponse>('/tenants', {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function updateTenant(id: string, input: UpdateTenantInput): Promise<TenantMutationResponse> {
    return run(() => apiClient.patch<TenantMutationResponse>(`/tenants/${id}`, {
      body: input as unknown as Record<string, unknown>
    }))
  }

  function deactivateTenant(id: string): Promise<DeactivateTenantResponse> {
    return run(() => apiClient.patch<DeactivateTenantResponse>(`/tenants/${id}/deactivate`))
  }

  function updateERPConfig(
    id: string,
    input: UpdateERPConfigInput
  ): Promise<TenantMutationResponse> {
    return run(() => apiClient.put<TenantMutationResponse>(`/tenants/${id}/erp-config`, {
      body: input as unknown as Record<string, unknown>
    }))
  }

  return {
    isLoading,
    error,
    listTenants,
    createTenant,
    updateTenant,
    deactivateTenant,
    updateERPConfig
  }
}
