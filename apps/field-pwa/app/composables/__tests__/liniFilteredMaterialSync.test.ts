// `fake-indexeddb/auto` installs a global IndexedDB so the Dexie singleton behind the
// real `useOfflineDb` runs under Node. It MUST be imported before anything touches `db`.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BusinessLine } from '@maction/types'
import type { MasterMaterial } from '@maction/types'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'
import type { ApiClientApi, GetOptions } from '../useApiClient'
import { useMasterDataSync, type AuthSource } from '../useMasterDataSync'

/**
 * Verification: lini-filtered material sync persistence (Phase 15).
 *
 * End-to-end complement to the backend RLS test (services/api-server): here we run
 * `useMasterDataSync` against the REAL Dexie `materials` table (via fake-indexeddb) and a
 * fake `/materials` endpoint that already returns a lini-scoped catalog (as backend RLS
 * would). We assert the PWA persists exactly those rows — no more, no fewer — proving that
 * only the user's assigned-lini materials end up cached locally and materials outside the
 * assignment are never written to IndexedDB.
 */

const COMPANY = 'company-a'
const USER = 'user-1'
const LINI_PHARMA = 'lini-pharma'
const LINI_ALKES = 'lini-alkes'

/** SALESMAN assigned PHARMA only. */
const AUTH: AuthSource = {
  isAuthenticated: true,
  identity: { company_id: COMPANY, user_id: USER, lini_ids: [LINI_PHARMA] }
}

function makeMaterial(overrides: Partial<MasterMaterial> & { id: string }): MasterMaterial {
  return {
    id: overrides.id,
    company_id: overrides.company_id ?? COMPANY,
    code: overrides.code ?? overrides.id,
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? null,
    business_line: overrides.business_line ?? BusinessLine.PHARMA,
    base_uom: overrides.base_uom ?? 'PCS',
    uom_conversion_rules: overrides.uom_conversion_rules ?? {},
    erp_material_code: overrides.erp_material_code ?? null,
    is_active: overrides.is_active ?? true,
    is_deleted: overrides.is_deleted ?? false,
    deleted_at: overrides.deleted_at ?? null,
    deleted_by: overrides.deleted_by ?? null,
    created_at: overrides.created_at ?? '2024-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2024-01-01T00:00:00.000Z'
  }
}

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

/** Fake API where `/materials` returns ONLY the already-lini-scoped rows (RLS-emulated). */
function makeApi(scopedMaterials: MasterMaterial[]): ApiClientApi {
  const routes: Record<string, unknown> = {
    '/customers': { data: [] },
    '/doctors': { data: [] },
    '/materials': { data: scopedMaterials },
    '/call-plans/today': { data: [] }
  }
  const get = (async (path: string, _options?: GetOptions<unknown>): Promise<unknown> => {
    if (!(path in routes)) throw new Error(`Unexpected path: ${path}`)
    return routes[path]
  }) as ApiClientApi['get']
  const notImpl = vi.fn()
  return {
    connectivity: { value: 'ONLINE' } as ApiClientApi['connectivity'],
    get,
    post: notImpl as unknown as ApiClientApi['post'],
    put: notImpl as unknown as ApiClientApi['put'],
    patch: notImpl as unknown as ApiClientApi['patch'],
    delete: notImpl as unknown as ApiClientApi['delete']
  }
}

describe('lini-filtered material sync — Dexie persistence', () => {
  let restoreOnline: () => void

  beforeEach(async () => {
    restoreOnline = setOnline(true)
    await db.materials.clear()
  })

  afterEach(async () => {
    restoreOnline()
    await db.materials.clear()
    vi.restoreAllMocks()
  })

  it('caches only the lini-scoped materials the API returns — nothing outside the assignment', async () => {
    // The API (post-RLS) returns only PHARMA rows for this PHARMA-assigned user.
    const scoped = [
      makeMaterial({ id: 'mat-pharma-1', business_line: BusinessLine.PHARMA }),
      makeMaterial({ id: 'mat-pharma-2', business_line: BusinessLine.PHARMA })
    ]
    const sync = useMasterDataSync({ api: makeApi(scoped), db: useOfflineDb(), auth: AUTH })

    const result = await sync.syncMasterData()
    expect(result).toBe('success')

    const cached = await db.materials.where('company_id').equals(COMPANY).toArray()
    expect(cached.map((m) => m.id).sort()).toEqual(['mat-pharma-1', 'mat-pharma-2'])
    // No ALKES material was ever returned, so none can be cached.
    expect(cached.some((m) => m.business_line === BusinessLine.ALKES)).toBe(false)
  })

  it('makes cached materials retrievable by the [company_id+business_line] index', async () => {
    const scoped = [makeMaterial({ id: 'mat-pharma-1', business_line: BusinessLine.PHARMA })]
    const offlineDb = useOfflineDb()
    const sync = useMasterDataSync({ api: makeApi(scoped), db: offlineDb, auth: AUTH })

    await sync.syncMasterData()

    const pharma = await offlineDb.listMaterialsByBusinessLine(COMPANY, BusinessLine.PHARMA)
    const alkes = await offlineDb.listMaterialsByBusinessLine(COMPANY, BusinessLine.ALKES)
    expect(pharma.map((m) => m.id)).toEqual(['mat-pharma-1'])
    // Querying an unassigned business line yields nothing — it was never cached.
    expect(alkes).toEqual([])
  })

  it('persists an empty catalog cleanly when the user has no in-scope materials', async () => {
    const sync = useMasterDataSync({ api: makeApi([]), db: useOfflineDb(), auth: AUTH })

    const result = await sync.syncMasterData()
    expect(result).toBe('success')
    expect(await db.materials.count()).toBe(0)
  })
})
