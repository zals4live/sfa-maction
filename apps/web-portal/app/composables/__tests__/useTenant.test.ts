import { describe, expect, it, vi } from 'vitest'
import { UserRole, type Company } from '@maction/types'
import type { ApiClientApi } from '../useApiClient'
import {
  useTenant,
  type TenantContext,
  type UseTenantOptions
} from '../useTenant'

/** Build a tenant context fixture, overriding fields per test. */
function makeContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    user_id: 'u1',
    company_id: 'company-home',
    soffice_id: 's1',
    role_label: UserRole.ADMIN_PUSAT,
    lini_ids: [],
    ...overrides
  }
}

/** Minimal Company fixture for tenant-list responses. */
function makeCompany(id: string, name: string): Company {
  return {
    id,
    code: name.toUpperCase(),
    name,
    is_active: true,
    logo_s3_key: null,
    default_tax_rate: 11,
    geofence_radius_meters: 100,
    erp_system_type: null,
    erp_endpoint_url: null,
    erp_auth_config: null,
    erp_company_code: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  }
}

/**
 * Build an API client stub whose GET resolves `value`. The generic `get<T>` surface is
 * satisfied by casting the fixed-return impl — mocks never exercise the generic narrowing.
 */
function makeApiClient(value: unknown = { data: [] }): { client: ApiClientApi, get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => value)
  const client: ApiClientApi = {
    get: get as unknown as ApiClientApi['get'],
    post: vi.fn() as unknown as ApiClientApi['post'],
    put: vi.fn() as unknown as ApiClientApi['put'],
    patch: vi.fn() as unknown as ApiClientApi['patch'],
    delete: vi.fn() as unknown as ApiClientApi['delete']
  }
  return { client, get }
}

/** Wire options with an injected API client and a local (off-Nuxt) state factory. */
function makeOptions(extra: Partial<UseTenantOptions> = {}): UseTenantOptions {
  return {
    apiClient: makeApiClient().client,
    ...extra
  }
}

describe('useTenant (web-portal)', () => {
  it('exposes the authenticated context reactively and pins home company', () => {
    const context = makeContext({ company_id: 'company-a', role_label: UserRole.ADMIN_CABANG })
    const tenant = useTenant(makeOptions({ context }))

    expect(tenant.context.value).toEqual(context)
    expect(tenant.homeCompanyId.value).toBe('company-a')
    expect(tenant.role.value).toBe(UserRole.ADMIN_CABANG)
    expect(tenant.effectiveCompanyId.value).toBe('company-a')
  })

  it('treats an absent context as unauthenticated', () => {
    const tenant = useTenant(makeOptions({ context: null }))

    expect(tenant.context.value).toBeNull()
    expect(tenant.homeCompanyId.value).toBeNull()
    expect(tenant.role.value).toBeNull()
    expect(tenant.isSuperAdmin.value).toBe(false)
    expect(tenant.canSwitchTenant.value).toBe(false)
  })

  it('marks SUPER_ADMIN as able to switch tenants', () => {
    const tenant = useTenant(makeOptions({ context: makeContext({ role_label: UserRole.SUPER_ADMIN }) }))

    expect(tenant.isSuperAdmin.value).toBe(true)
    expect(tenant.canSwitchTenant.value).toBe(true)
  })

  it('SUPER_ADMIN can list available tenants via the API client', async () => {
    const { client, get } = makeApiClient({ data: [makeCompany('t1', 'KFTD'), makeCompany('t2', 'KFA')] })
    const tenant = useTenant(makeOptions({
      context: makeContext({ role_label: UserRole.SUPER_ADMIN }),
      apiClient: client
    }))

    const loaded = await tenant.loadAvailableTenants()

    expect(get).toHaveBeenCalledWith('/tenants')
    expect(loaded.map(c => c.id)).toEqual(['t1', 't2'])
    expect(tenant.availableTenants.value).toHaveLength(2)
    expect(tenant.isLoadingTenants.value).toBe(false)
  })

  it('SUPER_ADMIN can select an active tenant and it drives effective company', () => {
    const tenant = useTenant(makeOptions({
      context: makeContext({ company_id: 'home', role_label: UserRole.SUPER_ADMIN })
    }))

    // Falls back to home company before any selection.
    expect(tenant.effectiveCompanyId.value).toBe('home')

    const applied = tenant.selectTenant('t2')

    expect(applied).toBe(true)
    expect(tenant.activeTenantId.value).toBe('t2')
    expect(tenant.effectiveCompanyId.value).toBe('t2')
  })

  it('setActiveTenant is an alias of selectTenant, and clearActiveTenant resets selection', () => {
    const tenant = useTenant(makeOptions({
      context: makeContext({ company_id: 'home', role_label: UserRole.SUPER_ADMIN })
    }))

    expect(tenant.setActiveTenant('t5')).toBe(true)
    expect(tenant.activeTenantId.value).toBe('t5')

    tenant.clearActiveTenant()
    expect(tenant.activeTenantId.value).toBeNull()
    expect(tenant.effectiveCompanyId.value).toBe('home')
  })

  it('non-super-admin selection is disallowed (no-op) and never hits the API', async () => {
    const { client, get } = makeApiClient({ data: [makeCompany('t1', 'KFTD')] })
    const tenant = useTenant(makeOptions({
      context: makeContext({ company_id: 'fixed', role_label: UserRole.ADMIN_PUSAT }),
      apiClient: client
    }))

    const applied = tenant.selectTenant('other-company')
    const loaded = await tenant.loadAvailableTenants()

    expect(applied).toBe(false)
    expect(tenant.activeTenantId.value).toBeNull()
    expect(tenant.effectiveCompanyId.value).toBe('fixed')
    expect(loaded).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('works without a Nuxt runtime by degrading useState to a local ref', () => {
    // No stateFactory injected and no global useState -> local ref fallback, no throw.
    const tenant = useTenant({
      apiClient: makeApiClient().client,
      context: makeContext({ role_label: UserRole.SUPER_ADMIN })
    })

    expect(() => tenant.selectTenant('t9')).not.toThrow()
    expect(tenant.activeTenantId.value).toBe('t9')
  })

  it('honors an injected state factory (shared Nuxt useState) for cross-page selection', () => {
    const shared = { value: null as string | null }
    const stateFactory = vi.fn(<T>(_key: string, init: () => T) => {
      if (shared.value === null) shared.value = init() as unknown as string | null
      return shared as unknown as { value: T }
    })
    const tenant = useTenant({
      apiClient: makeApiClient().client,
      context: makeContext({ role_label: UserRole.SUPER_ADMIN }),
      stateFactory: stateFactory as unknown as UseTenantOptions['stateFactory']
    })

    tenant.selectTenant('t3')
    expect(shared.value).toBe('t3')
  })
})
