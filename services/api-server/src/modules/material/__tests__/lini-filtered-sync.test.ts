import { describe, it, expect } from 'bun:test'

import { listMaterials } from '../service'
import type { MaterialRow } from './material-fixtures'
import { makeMaterialRow, makeRlsScopedTx } from './material-fixtures'

/**
 * Verification: lini-filtered material sync (Phase 15).
 *
 * The Field PWA hydrates its offline `materials` table from `GET /materials`,
 * which is served by `listMaterials` running inside a `withRLS` transaction. Lini
 * scoping for SALESMAN/MR is enforced entirely by the `master_material` RLS policy
 * (see infra/postgres/init-scripts/05_rls_policies.sql): a field user only sees rows
 * whose `lini_id` is in their active `user_lini_assignments` (or `lini_id IS NULL`).
 *
 * Because the PWA caches exactly what this endpoint returns (it never re-filters —
 * see apps/field-pwa/app/composables/useMasterDataSync.ts), proving the service only
 * ever surfaces RLS-scoped rows proves that materials outside the user's assigned lini
 * can never be cached locally. These tests simulate the RLS-scoped transaction (the DB
 * only hands back in-scope rows) and assert `listMaterials` returns exactly those.
 */

const COMPANY = '11111111-1111-1111-1111-111111111111'
const LINI_ETHICAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const LINI_GENERIK = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const LINI_ALKES = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

/**
 * A full tenant catalog spanning three business lines. In production the SALESMAN/MR
 * RLS policy hides rows outside the caller's assigned lini before they ever reach the
 * service; here the fixture transaction applies that same predicate.
 */
function fullCatalog(): MaterialRow[] {
  return [
    makeMaterialRow({ id: 'mat-eth-1', companyId: COMPANY, liniId: LINI_ETHICAL, name: 'Ethical A' }),
    makeMaterialRow({ id: 'mat-eth-2', companyId: COMPANY, liniId: LINI_ETHICAL, name: 'Ethical B' }),
    makeMaterialRow({ id: 'mat-gen-1', companyId: COMPANY, liniId: LINI_GENERIK, name: 'Generik A' }),
    makeMaterialRow({ id: 'mat-alk-1', companyId: COMPANY, liniId: LINI_ALKES, name: 'Alkes A' }),
    makeMaterialRow({ id: 'mat-glb-1', companyId: COMPANY, liniId: null, name: 'Unscoped Global' }),
  ]
}

describe('material sync — lini-scoped catalog (only assigned-lini materials reach the PWA cache)', () => {
  it('returns only materials in the field user assigned lini (others never surface to be cached)', async () => {
    // SALESMAN assigned ETHICAL only. RLS exposes ETHICAL rows + the unscoped (lini_id IS NULL) row.
    const tx = makeRlsScopedTx(fullCatalog(), { assignedLiniIds: [LINI_ETHICAL] })

    const result = await listMaterials(tx as never, {})

    const ids = result.data.map((m) => m.id).sort()
    expect(ids).toEqual(['mat-eth-1', 'mat-eth-2', 'mat-glb-1'])
    // Materials from GENERIK / ALKES are outside the assignment and must never be returned.
    expect(ids).not.toContain('mat-gen-1')
    expect(ids).not.toContain('mat-alk-1')
    expect(result.meta.total).toBe(3)
  })

  it('widens the cached set when the user is assigned multiple lini', async () => {
    const tx = makeRlsScopedTx(fullCatalog(), { assignedLiniIds: [LINI_ETHICAL, LINI_GENERIK] })

    const result = await listMaterials(tx as never, {})

    const ids = result.data.map((m) => m.id).sort()
    // ETHICAL (2) + GENERIK (1) + unscoped (1); ALKES still excluded.
    expect(ids).toEqual(['mat-eth-1', 'mat-eth-2', 'mat-gen-1', 'mat-glb-1'])
    expect(ids).not.toContain('mat-alk-1')
  })

  it('caches nothing but the unscoped global row when the user has no lini assignments', async () => {
    const tx = makeRlsScopedTx(fullCatalog(), { assignedLiniIds: [] })

    const result = await listMaterials(tx as never, {})

    // With no assignments only the lini_id IS NULL material is visible.
    expect(result.data.map((m) => m.id)).toEqual(['mat-glb-1'])
    expect(result.meta.total).toBe(1)
  })

  it('never leaks another tenant materials even within the assigned lini', async () => {
    const otherCompany = '99999999-9999-9999-9999-999999999999'
    const catalog: MaterialRow[] = [
      makeMaterialRow({ id: 'mine-eth', companyId: COMPANY, liniId: LINI_ETHICAL, name: 'Mine' }),
      // Same lini, different tenant — RLS company_id predicate must exclude it.
      makeMaterialRow({ id: 'theirs-eth', companyId: otherCompany, liniId: LINI_ETHICAL, name: 'Theirs' }),
    ]
    const tx = makeRlsScopedTx(catalog, { assignedLiniIds: [LINI_ETHICAL], companyId: COMPANY })

    const result = await listMaterials(tx as never, {})

    expect(result.data.map((m) => m.id)).toEqual(['mine-eth'])
    expect(result.data.map((m) => m.company_id)).not.toContain(otherCompany)
  })

  it('excludes soft-deleted materials from the cached set', async () => {
    const catalog: MaterialRow[] = [
      makeMaterialRow({ id: 'live', companyId: COMPANY, liniId: LINI_ETHICAL, isDeleted: false }),
      makeMaterialRow({ id: 'gone', companyId: COMPANY, liniId: LINI_ETHICAL, isDeleted: true }),
    ]
    const tx = makeRlsScopedTx(catalog, { assignedLiniIds: [LINI_ETHICAL] })

    const result = await listMaterials(tx as never, {})

    expect(result.data.map((m) => m.id)).toEqual(['live'])
  })
})
