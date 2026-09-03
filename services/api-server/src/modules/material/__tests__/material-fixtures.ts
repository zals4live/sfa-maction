import type { masterMaterial } from '../../../db/schema/material'

/** A `master_material` row as Drizzle's inferred select type. */
export type MaterialRow = typeof masterMaterial.$inferSelect

/** Build a `master_material` row with sensible defaults, overridable per test. */
export function makeMaterialRow(overrides: Partial<MaterialRow> & { id: string; companyId: string }): MaterialRow {
  return {
    id: overrides.id,
    companyId: overrides.companyId,
    erpMaterialCode: overrides.erpMaterialCode ?? `ERP-${overrides.id}`,
    name: overrides.name ?? overrides.id,
    baseUom: overrides.baseUom ?? 'PCS',
    salesUom: overrides.salesUom ?? 'BOX',
    nie: overrides.nie ?? null,
    validNie: overrides.validNie ?? null,
    liniId: overrides.liniId ?? null,
    manufacture: overrides.manufacture ?? null,
    principal: overrides.principal ?? null,
    uomConversionRules: overrides.uomConversionRules ?? {},
    isNarcoticPsychotropic: overrides.isNarcoticPsychotropic ?? false,
    isActive: overrides.isActive ?? true,
    isDeleted: overrides.isDeleted ?? false,
    deletedAt: overrides.deletedAt ?? null,
    deletedBy: overrides.deletedBy ?? null,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00.000Z',
  }
}

/** RLS scoping applied by the fixture transaction, mirroring the master_material policy. */
export interface RlsScope {
  /** Active `user_lini_assignments.lini_id` values for the caller (empty = none assigned). */
  assignedLiniIds: string[]
  /** Tenant `company_id` the caller is scoped to; defaults to every row's own company. */
  companyId?: string
}

/**
 * Applies the SALESMAN/MR `master_material` RLS predicate to an in-memory catalog:
 *   company_id match AND (lini_id IS NULL OR lini_id IN assigned active lini).
 * This is what PostgreSQL enforces before rows ever reach the service.
 */
function applyRlsScope(catalog: MaterialRow[], scope: RlsScope): MaterialRow[] {
  const assigned = new Set(scope.assignedLiniIds)
  return catalog.filter((row) => {
    if (scope.companyId !== undefined && row.companyId !== scope.companyId) return false
    return row.liniId === null || assigned.has(row.liniId)
  })
}

/**
 * A minimal Drizzle-like transaction over an RLS-scoped catalog. It supports the exact
 * chains `listMaterials` issues:
 *   - list:  select().from().where().limit().offset().orderBy() → rows
 *   - count: select({ total }).from().where() → [{ total }]
 * The `.where()` clause here always encodes `isDeleted = false` (the only app-level filter
 * with default params), applied on top of the RLS-scoped rows.
 */
export function makeRlsScopedTx(catalog: MaterialRow[], scope: RlsScope) {
  const visible = applyRlsScope(catalog, scope).filter((row) => row.isDeleted === false)

  const makeChain = (isCount: boolean) => {
    let limit = visible.length
    let offset = 0
    const chain: Record<string, unknown> = {}
    chain.from = () => chain
    chain.where = () => (isCount ? Promise.resolve([{ total: visible.length }]) : chain)
    chain.limit = (n: number) => {
      limit = n
      return chain
    }
    chain.offset = (n: number) => {
      offset = n
      return chain
    }
    chain.orderBy = () => Promise.resolve(visible.slice(offset, offset + limit))
    return chain
  }

  return {
    // `select()` with no args = list query; `select({ total: count() })` = count query.
    select: (projection?: unknown) => makeChain(projection !== undefined),
  }
}
