/**
 * `useTenant` — tenant context + tenant-selection for the Web Portal (admin, SSR).
 *
 * The single abstraction admin pages use to answer "which company am I operating on?".
 * The web-portal is server-rendered and always online; the JWT lives in an HttpOnly
 * cookie and the backend `tenantGuard` derives the real RLS context from it. This
 * composable does NOT re-implement auth or trust the client for isolation — it mirrors
 * the authenticated claims (`company_id`, `role_label`, `soffice_id`, `user_id`,
 * `lini_ids`) so UI can branch on role, and it layers cross-tenant *selection* on top
 * for the one role allowed to switch: `SUPER_ADMIN`.
 *
 * Role model (see security.md / product.md):
 *  - `SUPER_ADMIN` operates cross-tenant (tenant provisioning/governance). It may list
 *    all companies (`GET /tenants`, via {@link useApiClient}) and pick an *active* tenant
 *    to view. The active selection is view-only convenience state; the backend still
 *    enforces every cross-tenant read through the super-admin service connection.
 *  - `ADMIN_PUSAT` / `ADMIN_CABANG` / `SALESMAN` / `MR` are pinned to their JWT
 *    `company_id`. For them selection is a no-op and `canSwitchTenant` is false.
 *
 * Testability mirrors the sibling composables: everything external is injectable via an
 * options object (the authenticated context, an API client, and the state factory), and
 * nothing throws outside a Nuxt runtime — off-Nuxt it degrades to a plain `ref`.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { UserRole, type Company } from '@maction/types'
import { useApiClient, type ApiClientApi, type ApiClientOptions } from './useApiClient'

/** Nuxt state key backing the SUPER_ADMIN active-tenant selection (shared across pages). */
export const ACTIVE_TENANT_STATE_KEY = 'maction:web-portal:active-tenant-id'

/**
 * The authenticated tenant context mirrored from the JWT claims. Structurally aligned
 * with the auth store's `AuthProfile`, so callers can pass the store profile directly.
 */
export interface TenantContext {
  user_id: string
  company_id: string
  soffice_id: string
  role_label: UserRole
  lini_ids: string[]
}

/** Backend `{ data }` envelope for `GET /tenants` (list of companies). */
interface TenantListResponse {
  data: Company[]
}

/**
 * A minimal SSR-safe state factory. Runtime supplies Nuxt `useState` (shared across the
 * request/render); off-Nuxt (unit tests) it degrades to a local `ref`. Injectable so tests
 * can assert selection without a Nuxt runtime.
 */
export type StateFactory = <T>(key: string, init: () => T) => Ref<T>

/** Options for {@link useTenant}; all optional so runtime and tests can diverge. */
export interface UseTenantOptions {
  /**
   * The authenticated context (mirrored JWT claims). Runtime resolves it from the auth
   * store / SSR context before calling; tests inject a fixture. When absent, the context
   * is treated as unauthenticated (no company, no switching).
   */
  context?: TenantContext | null
  /** Inject an API client (tests supply a mock); runtime falls back to {@link useApiClient}. */
  apiClient?: ApiClientApi
  /** Options forwarded to the default {@link useApiClient} when no client is injected. */
  apiClientOptions?: ApiClientOptions
  /** Override the SSR-safe state factory (defaults to Nuxt `useState`, else a local ref). */
  stateFactory?: StateFactory
}

/** Public surface returned by {@link useTenant}. */
export interface UseTenantApi {
  /** The authenticated context, or null when unauthenticated. */
  context: ComputedRef<TenantContext | null>
  /** The authenticated user's own company id (from JWT), independent of any selection. */
  homeCompanyId: ComputedRef<string | null>
  /** The authenticated user's role. */
  role: ComputedRef<UserRole | null>
  /** Whether the current user is a cross-tenant SUPER_ADMIN. */
  isSuperAdmin: ComputedRef<boolean>
  /** Whether the current user may switch the active tenant (SUPER_ADMIN only). */
  canSwitchTenant: ComputedRef<boolean>
  /** SUPER_ADMIN's selected tenant id, or null when none selected. */
  activeTenantId: ComputedRef<string | null>
  /**
   * The effective company id in scope: the selected tenant for SUPER_ADMIN (falling back
   * to their home company), or the fixed home company for every other role.
   */
  effectiveCompanyId: ComputedRef<string | null>
  /** Loaded list of companies available for SUPER_ADMIN selection. */
  availableTenants: Ref<Company[]>
  /** Whether {@link loadAvailableTenants} is in flight. */
  isLoadingTenants: Ref<boolean>
  /** Load selectable tenants via `GET /tenants` (SUPER_ADMIN only; no-op otherwise). */
  loadAvailableTenants: () => Promise<Company[]>
  /** Select an active tenant (SUPER_ADMIN only). Returns true when the selection applied. */
  selectTenant: (companyId: string | null) => boolean
  /** Alias of {@link selectTenant} for call-site readability. */
  setActiveTenant: (companyId: string | null) => boolean
  /** Clear any active-tenant selection (SUPER_ADMIN only). */
  clearActiveTenant: () => void
}

/**
 * Resolve the SSR-safe state factory: Nuxt `useState` when present (shared across the
 * render), else a local `ref` so unit tests and non-Nuxt contexts still work. Never throws.
 */
function resolveStateFactory(explicit?: StateFactory): StateFactory {
  if (explicit) return explicit
  const hook = (globalThis as {
    useState?: <T>(key: string, init: () => T) => Ref<T>
  }).useState
  if (typeof hook === 'function') {
    return <T>(key: string, init: () => T): Ref<T> => {
      try {
        return hook<T>(key, init)
      } catch {
        return ref(init()) as Ref<T>
      }
    }
  }
  return <T>(_key: string, init: () => T): Ref<T> => ref(init()) as Ref<T>
}

export function useTenant(options: UseTenantOptions = {}): UseTenantApi {
  const context = ref<TenantContext | null>(options.context ?? null)
  const apiClient = options.apiClient ?? useApiClient(options.apiClientOptions)
  const state = resolveStateFactory(options.stateFactory)

  // Cross-page selection state. Only meaningful for SUPER_ADMIN; other roles never write it.
  const selectedTenantId = state<string | null>(ACTIVE_TENANT_STATE_KEY, () => null)

  const availableTenants = ref<Company[]>([])
  const isLoadingTenants = ref<boolean>(false)

  const role = computed<UserRole | null>(() => context.value?.role_label ?? null)
  const homeCompanyId = computed<string | null>(() => context.value?.company_id ?? null)
  const isSuperAdmin = computed<boolean>(() => role.value === UserRole.SUPER_ADMIN)
  const canSwitchTenant = computed<boolean>(() => isSuperAdmin.value)

  // Non-super-admins can never have an active selection, even if state was somehow set.
  const activeTenantId = computed<string | null>(() =>
    canSwitchTenant.value ? selectedTenantId.value : null
  )

  const effectiveCompanyId = computed<string | null>(() => {
    if (canSwitchTenant.value) return activeTenantId.value ?? homeCompanyId.value
    return homeCompanyId.value
  })

  /** Load selectable tenants for SUPER_ADMIN; a no-op returning [] for other roles. */
  async function loadAvailableTenants(): Promise<Company[]> {
    if (!canSwitchTenant.value) {
      availableTenants.value = []
      return []
    }
    isLoadingTenants.value = true
    try {
      const response = await apiClient.get<TenantListResponse>('/tenants')
      availableTenants.value = response?.data ?? []
      return availableTenants.value
    } finally {
      isLoadingTenants.value = false
    }
  }

  /** Apply an active-tenant selection; disallowed (no-op, false) for non-super-admins. */
  function selectTenant(companyId: string | null): boolean {
    if (!canSwitchTenant.value) return false
    selectedTenantId.value = companyId
    return true
  }

  /** Clear the active-tenant selection (SUPER_ADMIN only). */
  function clearActiveTenant(): void {
    if (!canSwitchTenant.value) return
    selectedTenantId.value = null
  }

  return {
    context: computed(() => context.value),
    homeCompanyId,
    role,
    isSuperAdmin,
    canSwitchTenant,
    activeTenantId,
    effectiveCompanyId,
    availableTenants,
    isLoadingTenants,
    loadAvailableTenants,
    selectTenant,
    setActiveTenant: selectTenant,
    clearActiveTenant
  }
}
