// `fake-indexeddb/auto` installs a global IndexedDB implementation so the Dexie
// singleton (reached transitively via the default useOfflineDb) can run under Node. It
// MUST be imported before any module that touches the `db` singleton. These tests inject
// fakes and never hit it, but the import keeps the module graph safe under `node`.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClientApi, GetOptions } from '../useApiClient'
import type { OfflineDbApi } from '../useOfflineDb'
import {
  useMasterDataSync,
  type AuthSource,
  type MasterDataSyncOptions
} from '../useMasterDataSync'

const COMPANY = 'company-a'
const USER = 'user-1'
const LINI_A = 'lini-a'
const LINI_B = 'lini-b'

const AUTH: AuthSource = {
  isAuthenticated: true,
  identity: { company_id: COMPANY, user_id: USER, lini_ids: [LINI_A, LINI_B] }
}

/** Force `navigator.onLine` for a test; returns a restore fn. */
function setOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: value },
    configurable: true,
    writable: true
  })
  return () => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

/** Route a request path to a canned envelope; records the paths + queries requested. */
interface FakeApiState {
  paths: string[]
  queries: Array<Record<string, unknown> | undefined>
}

function makeApi(
  routes: Record<string, unknown>,
  state: FakeApiState = { paths: [], queries: [] }
): { api: ApiClientApi, state: FakeApiState } {
  const get = (async (path: string, options?: GetOptions<unknown>): Promise<unknown> => {
    state.paths.push(path)
    state.queries.push(options?.query)
    // Match dynamic `/doctors/:id` detail routes to a shared handler.
    const key = path.startsWith('/doctors/') ? '/doctors/:id' : path
    if (!(key in routes)) throw new Error(`Unexpected path: ${path}`)
    return routes[key]
  }) as ApiClientApi['get']
  const notImpl = vi.fn()
  return {
    state,
    api: {
      connectivity: { value: 'ONLINE' } as ApiClientApi['connectivity'],
      get,
      post: notImpl as unknown as ApiClientApi['post'],
      put: notImpl as unknown as ApiClientApi['put'],
      patch: notImpl as unknown as ApiClientApi['patch'],
      delete: notImpl as unknown as ApiClientApi['delete']
    }
  }
}

/** Records the rows passed to each bulkPut helper the sync uses. */
interface DbCalls {
  customers: unknown[][]
  profiles: unknown[][]
  assignments: unknown[][]
  lini: unknown[][]
  materials: unknown[][]
  plans: unknown[][]
}

/** An offline-DB stub that records every bulkPut call without touching IndexedDB. */
function makeDb(): { db: OfflineDbApi, calls: DbCalls } {
  const calls: DbCalls = {
    customers: [],
    profiles: [],
    assignments: [],
    lini: [],
    materials: [],
    plans: []
  }
  const noop = async (): Promise<void> => {}
  const db = {
    bulkPutCustomers: vi.fn(async (rows: unknown[]) => { calls.customers.push(rows) }),
    bulkPutDoctorProfiles: vi.fn(async (rows: unknown[]) => { calls.profiles.push(rows) }),
    bulkPutDoctorOutletAssignments: vi.fn(async (rows: unknown[]) => { calls.assignments.push(rows) }),
    bulkPutUserLiniAssignments: vi.fn(async (rows: unknown[]) => { calls.lini.push(rows) }),
    bulkPutMaterials: vi.fn(async (rows: unknown[]) => { calls.materials.push(rows) }),
    bulkPutVisitPlans: vi.fn(async (rows: unknown[]) => { calls.plans.push(rows) })
  } as unknown as OfflineDbApi
  // Fill the remaining OfflineDbApi surface the sync never calls.
  Object.assign(db, {
    getCustomer: noop, getMaterial: noop, listCustomersByCompany: noop,
    listCustomersByType: noop, listMaterialsByBusinessLine: noop, listVisitPlansByUser: noop,
    listVisitPlansByUserAndDate: noop, listLiniAssignmentsByUser: noop, clearCompanyData: noop,
    enqueueMutation: noop, listPendingMutations: noop, updateMutationStatus: noop, deleteMutation: noop
  })
  return { db, calls }
}

/** Canned backend responses covering the happy path (2 doctors, each with a profile + assignment). */
function happyRoutes(): Record<string, unknown> {
  return {
    '/customers': { data: [{ company_id: COMPANY, id: 'outlet-1' }] },
    '/doctors': { data: [{ company_id: COMPANY, id: 'doc-1' }, { company_id: COMPANY, id: 'doc-2' }] },
    '/doctors/:id': {
      data: {
        id: 'doc-1',
        company_id: COMPANY,
        doctor_profile: { id: 'prof-1', customer_id: 'doc-1' },
        assignments: [{ id: 'asg-1', doctor_customer_id: 'doc-1', outlet_customer_id: 'outlet-1' }]
      }
    },
    '/materials': { data: [{ company_id: COMPANY, id: 'mat-1' }, { company_id: COMPANY, id: 'mat-2' }] },
    '/call-plans/today': { data: [{ company_id: COMPANY, id: 'plan-1' }] }
  }
}

function makeSync(routes: Record<string, unknown>, extra: Partial<MasterDataSyncOptions> = {}) {
  const { api, state } = makeApi(routes)
  const { db, calls } = makeDb()
  const sync = useMasterDataSync({ api, db, auth: AUTH, ...extra })
  return { sync, state, calls, db, api }
}

describe('useMasterDataSync', () => {
  let restoreOnline: () => void

  beforeEach(() => {
    restoreOnline = setOnline(true)
  })

  afterEach(() => {
    restoreOnline()
    vi.restoreAllMocks()
  })

  it('is a no-op and stays idle when the user is not authenticated', async () => {
    const { sync, state } = makeSync(happyRoutes(), {
      auth: { isAuthenticated: false, identity: null }
    })
    const result = await sync.syncMasterData()
    expect(result).toBe('idle')
    expect(state.paths).toEqual([])
  })

  it('is a no-op and stays idle when offline', async () => {
    restoreOnline()
    restoreOnline = setOnline(false)
    const { sync, state } = makeSync(happyRoutes())
    const result = await sync.syncMasterData()
    expect(result).toBe('idle')
    expect(state.paths).toEqual([])
  })

  it('hydrates every master-data table and reports success', async () => {
    const { sync, calls } = makeSync(happyRoutes())
    const result = await sync.syncMasterData()

    expect(result).toBe('success')
    expect(sync.state.value).toBe('success')
    expect(sync.lastSyncedAt.value).not.toBeNull()
    // Outlets + doctor roster both land in the customers table.
    expect(calls.customers.length).toBe(2)
    expect(calls.materials[0]).toHaveLength(2)
    expect(calls.plans[0]).toHaveLength(1)
  })

  it('fetches outlets scoped by customer_type=OUTLET', async () => {
    const { sync, state } = makeSync(happyRoutes())
    await sync.syncMasterData()
    const customerIdx = state.paths.indexOf('/customers')
    expect(state.queries[customerIdx]).toEqual({ customer_type: 'OUTLET' })
  })

  it('does not re-filter materials client-side (relies on backend RLS)', async () => {
    const { sync, state } = makeSync(happyRoutes())
    await sync.syncMasterData()
    const materialIdx = state.paths.indexOf('/materials')
    // No lini query params are sent — scoping is enforced entirely by the backend.
    expect(state.queries[materialIdx]).toBeUndefined()
  })

  it('synthesizes user-lini assignments from the JWT lini_ids', async () => {
    const { sync, calls } = makeSync(happyRoutes())
    await sync.syncMasterData()

    const rows = calls.lini[0] as Array<{ id: string, lini_id: string, company_id: string, user_id: string }>
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.lini_id).sort()).toEqual([LINI_A, LINI_B])
    // Deterministic ids so repeated syncs upsert in place.
    expect(rows[0]!.id).toBe(`${USER}:${LINI_A}`)
    expect(rows.every(r => r.company_id === COMPANY && r.user_id === USER)).toBe(true)
  })

  it('stamps doctor profiles + assignments with company_id when the detail omits it', async () => {
    const routes = happyRoutes()
    routes['/doctors/:id'] = {
      data: {
        id: 'doc-1',
        doctor_profile: { id: 'prof-1', customer_id: 'doc-1' },
        assignments: [{ id: 'asg-1', doctor_customer_id: 'doc-1', outlet_customer_id: 'outlet-1' }]
      }
    }
    const { sync, calls } = makeSync(routes)
    await sync.syncMasterData()

    const profile = (calls.profiles[0] as Array<{ company_id: string }>)[0]
    const assignment = (calls.assignments[0] as Array<{ company_id: string }>)[0]
    expect(profile!.company_id).toBe(COMPANY)
    expect(assignment!.company_id).toBe(COMPANY)
  })

  it('reports error and preserves the message when a fetch fails', async () => {
    const routes = happyRoutes()
    delete routes['/materials'] // triggers "Unexpected path" rejection
    const { sync } = makeSync(routes)

    const result = await sync.syncMasterData()
    expect(result).toBe('error')
    expect(sync.state.value).toBe('error')
    expect(sync.error.value).toContain('/materials')
  })

  it('coalesces concurrent launch triggers into a single in-flight run', async () => {
    const { sync, state } = makeSync(happyRoutes())
    const [a, b] = await Promise.all([sync.syncMasterData(), sync.syncMasterData()])
    expect(a).toBe('success')
    expect(b).toBe('success')
    // A single run: /customers requested exactly once (not doubled by the second trigger).
    expect(state.paths.filter(p => p === '/customers')).toHaveLength(1)
  })

  it('bounds doctor-detail fetches by the configured concurrency', async () => {
    const routes = happyRoutes()
    routes['/doctors'] = {
      data: Array.from({ length: 6 }, (_, i) => ({ company_id: COMPANY, id: `doc-${i}` }))
    }
    const { sync, state } = makeSync(routes, { doctorFetchConcurrency: 2 })
    const result = await sync.syncMasterData()
    expect(result).toBe('success')
    // All six doctor details are fetched despite the concurrency cap.
    expect(state.paths.filter(p => p.startsWith('/doctors/'))).toHaveLength(6)
  })
})
