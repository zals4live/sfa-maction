import { eq, and, ilike, or, count, sql, desc, asc, gte, lte } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { masterMaterial, masterPrice, stockInventoryAtp, masterPromotions } from '../../db/schema/material'
import type {
  ListMaterialsParams,
  MaterialPriceParams,
  MaterialStockParams,
  ListPromotionsParams,
  MaterialResponseType,
  MaterialPriceResponseType,
  MaterialStockResponseType,
  PromotionResponseType,
} from './schemas'

/** Structured error thrown by service functions for route-level handling. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
  }
}

// --- Mappers ---

type MaterialRow = typeof masterMaterial.$inferSelect
type PriceRow = typeof masterPrice.$inferSelect
type StockRow = typeof stockInventoryAtp.$inferSelect
type PromotionRow = typeof masterPromotions.$inferSelect

function mapMaterialToResponse(row: MaterialRow): MaterialResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    erp_material_code: row.erpMaterialCode,
    name: row.name,
    base_uom: row.baseUom,
    sales_uom: row.salesUom,
    nie: row.nie ?? null,
    valid_nie: row.validNie ?? null,
    lini_id: row.liniId ?? null,
    manufacture: row.manufacture ?? null,
    principal: row.principal ?? null,
    uom_conversion_rules: row.uomConversionRules,
    is_narcotic_psychotropic: row.isNarcoticPsychotropic ?? false,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

function mapPriceToResponse(row: PriceRow): MaterialPriceResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    soffice_id: row.sofficeId,
    material_id: row.materialId,
    varian_id: row.varianId ?? null,
    price_regular: Number(row.priceRegular),
    price_hja: row.priceHja !== null ? Number(row.priceHja) : null,
    price_het: row.priceHet !== null ? Number(row.priceHet) : null,
    per: row.per,
    sales_uom: row.salesUom,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

function mapStockToResponse(row: StockRow): MaterialStockResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    soffice_id: row.sofficeId,
    material_id: row.materialId,
    varian_id: row.varianId ?? null,
    batch: row.batch,
    sled: row.sled ?? null,
    qty_available: Number(row.qtyAvailable),
    qty_allocated: Number(row.qtyAllocated),
    stock_value: row.stockValue !== null ? Number(row.stockValue) : null,
    uom: row.uom,
    last_synced_at: row.lastSyncedAt ?? null,
  }
}

function mapPromotionToResponse(row: PromotionRow): PromotionResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    promo_code: row.promoCode,
    promo_name: row.promoName,
    promo_type: row.promoType,
    discount_percentage: row.discountPercentage !== null ? Number(row.discountPercentage) : null,
    discount_amount: row.discountAmount !== null ? Number(row.discountAmount) : null,
    min_order_qty: row.minOrderQty ?? null,
    free_material_id: row.freeMaterialId ?? null,
    free_material_qty: row.freeMaterialQty ?? null,
    valid_start: row.validStart,
    valid_end: row.validEnd,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

// --- Material Reads ---

/** Lists non-deleted materials with pagination, search, and lini/active filters (lini scoping also enforced by RLS). */
export async function listMaterials(
  tx: Transaction,
  params: ListMaterialsParams
): Promise<{ data: MaterialResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const whereClause = and(...buildMaterialFilters(params))

  const [rows, totalResult] = await Promise.all([
    tx
      .select()
      .from(masterMaterial)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(masterMaterial.name),
    tx.select({ total: count() }).from(masterMaterial).where(whereClause),
  ])

  return {
    data: rows.map(mapMaterialToResponse),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

/** Retrieves a single non-deleted material by id. */
export async function getMaterialById(tx: Transaction, id: string): Promise<MaterialResponseType> {
  const [row] = await tx
    .select()
    .from(masterMaterial)
    .where(and(eq(masterMaterial.id, id), eq(masterMaterial.isDeleted, false)))

  if (!row) {
    throw new ServiceError('MATERIAL_NOT_FOUND', `Material '${id}' not found`, 404)
  }

  return mapMaterialToResponse(row)
}

/**
 * Resolves today's (or an as-of) date as a YYYY-MM-DD string for price validity
 * matching. A supplied `as_of` (already `format: 'date'`-validated) is used
 * verbatim; otherwise the current UTC date is applied.
 */
export function resolveAsOfDate(asOf?: string): string {
  return asOf ?? new Date().toISOString().slice(0, 10)
}

/**
 * Builds the WHERE conditions for a regional `master_price` lookup: material +
 * optional branch (soffice) + variant + a validity window enclosing `asOf`
 * (`valid_from <= asOf <= valid_to`). When `varian_id` is provided it must match
 * exactly; otherwise only variant-agnostic (`varian_id IS NULL`) rows are matched
 * so a specific variant price is never returned for a generic request.
 */
export function buildPriceConditions(
  materialId: string,
  params: MaterialPriceParams,
  asOf: string
) {
  const conditions = [
    eq(masterPrice.materialId, materialId),
    lte(masterPrice.validFrom, asOf),
    gte(masterPrice.validTo, asOf),
  ]
  if (params.soffice_id) conditions.push(eq(masterPrice.sofficeId, params.soffice_id))
  conditions.push(
    params.varian_id
      ? eq(masterPrice.varianId, params.varian_id)
      : sql`${masterPrice.varianId} IS NULL`
  )
  return conditions
}

/**
 * Regional price lookup: resolves the most-recent `master_price` record valid on
 * the query date for a material, scoped by sales office (soffice) and variant.
 * The material must exist (tenant + lini scoping enforced by RLS); a
 * `PRICE_NOT_FOUND` error is thrown when no record covers the requested date.
 */
export async function getMaterialPrice(
  tx: Transaction,
  materialId: string,
  params: MaterialPriceParams
): Promise<MaterialPriceResponseType> {
  await assertMaterialExists(tx, materialId)

  const asOf = resolveAsOfDate(params.as_of)
  const conditions = buildPriceConditions(materialId, params, asOf)

  const [row] = await tx
    .select()
    .from(masterPrice)
    .where(and(...conditions))
    .orderBy(desc(masterPrice.validFrom))
    .limit(1)

  if (!row) {
    throw new ServiceError(
      'PRICE_NOT_FOUND',
      `No valid price found for material '${materialId}' on ${asOf}`,
      404
    )
  }

  return mapPriceToResponse(row)
}

/** Returns ATP stock rows (FEFO — earliest SLED first) for a material + optional branch/variant. */
export async function getMaterialStock(
  tx: Transaction,
  materialId: string,
  params: MaterialStockParams
): Promise<MaterialStockResponseType[]> {
  await assertMaterialExists(tx, materialId)

  const conditions = [eq(stockInventoryAtp.materialId, materialId)]
  if (params.varian_id) conditions.push(eq(stockInventoryAtp.varianId, params.varian_id))
  if (params.soffice_id) conditions.push(eq(stockInventoryAtp.sofficeId, params.soffice_id))

  const rows = await tx
    .select()
    .from(stockInventoryAtp)
    .where(and(...conditions))
    .orderBy(asc(stockInventoryAtp.sled))

  return rows.map(mapStockToResponse)
}

/** Lists non-deleted promotions with pagination, active, and validity-date filters. */
export async function listPromotions(
  tx: Transaction,
  params: ListPromotionsParams
): Promise<{ data: PromotionResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const whereClause = and(...buildPromotionFilters(params))

  const [rows, totalResult] = await Promise.all([
    tx
      .select()
      .from(masterPromotions)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(desc(masterPromotions.validStart)),
    tx.select({ total: count() }).from(masterPromotions).where(whereClause),
  ])

  return {
    data: rows.map(mapPromotionToResponse),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

// --- Internal Helpers ---

function buildMaterialFilters(params: ListMaterialsParams) {
  const conditions = [eq(masterMaterial.isDeleted, false)]

  if (params.search) {
    conditions.push(
      or(
        ilike(masterMaterial.name, `%${params.search}%`),
        ilike(masterMaterial.erpMaterialCode, `%${params.search}%`)
      )!
    )
  }
  if (params.lini_id) {
    conditions.push(eq(masterMaterial.liniId, params.lini_id))
  }
  if (params.is_active !== undefined) {
    conditions.push(eq(masterMaterial.isActive, params.is_active))
  }

  return conditions
}

function buildPromotionFilters(params: ListPromotionsParams) {
  const conditions = [eq(masterPromotions.isDeleted, false)]

  if (params.is_active !== undefined) {
    conditions.push(eq(masterPromotions.isActive, params.is_active))
  }
  if (params.as_of) {
    const asOf = sql`${params.as_of}::timestamptz`
    conditions.push(lte(masterPromotions.validStart, asOf))
    conditions.push(gte(masterPromotions.validEnd, asOf))
  }

  return conditions
}

async function assertMaterialExists(tx: Transaction, materialId: string): Promise<void> {
  const [row] = await tx
    .select({ id: masterMaterial.id })
    .from(masterMaterial)
    .where(and(eq(masterMaterial.id, materialId), eq(masterMaterial.isDeleted, false)))

  if (!row) {
    throw new ServiceError('MATERIAL_NOT_FOUND', `Material '${materialId}' not found`, 404)
  }
}
