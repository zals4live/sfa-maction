import { randomUUID } from 'node:crypto'

import { eq, and, sql, count, gte, lte } from 'drizzle-orm'

import {
  computeLinePricing,
  computeOrderTotals,
  convertToBaseUnits,
  getUomFactor,
  UOMConversionError,
  type UOMConversionRules,
} from '@maction/utils'

import { withRLS, type RLSContext, type Transaction } from '../../db'
import { generateDownloadUrl, uploadObject, buildS3Key } from '../../config/s3'
import { orders, orderItems, orderSequences } from '../../db/schema/order'
import { masterMaterial, masterPrice, masterPromotions } from '../../db/schema/material'
import { masterCustomer } from '../../db/schema/customer'
import { companies } from '../../db/schema/tenant'
import { renderQuotationPdf, type QuotationData, type QuotationLine } from './pdf'
import {
  resolveDiscountPercentage,
  resolveLineDiscount,
  promotionHasFreeGoods,
  type ActivePromotion,
} from './promotion'
import type {
  CreateOrderInput,
  CreateOrderItemInput,
  ListOrdersParams,
  OrderResponseType,
  OrderItemResponseType,
  OrderDetailResponseType,
  OrderListResponseType,
} from './schemas'

/** Structured error thrown by service functions for route-level handling. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

/** Context required for order operations (derived from JWT claims). */
export interface OrderContext {
  companyId: string
  userId: string
  sofficeId: string
  userRole: string
}

/** Fully resolved pricing for a single order line, ready to persist. */
export interface ResolvedOrderLine {
  materialId: string
  qty: number
  uom: string
  unitPrice: number
  discountPercentage: number
  discountAmount: number
  subtotal: number
  promotionId: string | null
  isFreeGoods: boolean
}

// =============================================================================
// Order Creation
// =============================================================================

/**
 * Creates a DRAFT order for a Salesman. Each line item is priced via a regional
 * price lookup (soffice + material + varian, valid for today), converted through
 * the material's multi-tier UOM rules, discounted by any applicable promotion,
 * and summed into PPN-taxed order totals. The header + all items are written in a
 * single RLS-scoped transaction.
 */
export async function createOrder(
  input: CreateOrderInput,
  ctx: OrderContext
): Promise<OrderDetailResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const orderDate = getTodayDateString()
    const resolvedLines = await resolveOrderLines(tx, input.items, ctx, orderDate)
    const taxRate = await getDefaultTaxRate(tx, ctx.companyId)

    const totals = computeOrderTotals({
      lineSubtotals: resolvedLines.map((l) => l.subtotal),
      lineDiscounts: resolvedLines.map((l) => l.discountAmount),
      taxRate,
    })

    const orderNumber = await generateOrderNumber(tx, ctx.companyId, orderDate)

    const [header] = await tx
      .insert(orders)
      .values({
        companyId: ctx.companyId,
        sofficeId: ctx.sofficeId,
        userId: ctx.userId,
        customerId: input.customer_id,
        doctorCustomerId: input.doctor_customer_id ?? null,
        visitId: input.visit_id ?? null,
        orderNumber,
        orderDate,
        subtotalAmount: String(totals.subtotalAmount),
        totalDiscountAmount: String(totals.totalDiscountAmount),
        taxRate: String(taxRate),
        taxAmount: String(totals.taxAmount),
        grandTotal: String(totals.grandTotal),
        orderStatus: 'DRAFT',
      })
      .returning()

    if (!header) throw new Error('Order insert returned no rows')

    const itemRows = await insertOrderItems(tx, header.id, resolvedLines)

    return { ...mapOrderRow(header), items: itemRows.map(mapOrderItemRow) }
  })
}

/**
 * Resolves each request line into a fully priced order line. Kept sequential so
 * a pricing/UOM error for any line surfaces before any write occurs.
 */
async function resolveOrderLines(
  tx: Transaction,
  items: CreateOrderItemInput[],
  ctx: OrderContext,
  orderDate: string
): Promise<ResolvedOrderLine[]> {
  const resolved: ResolvedOrderLine[] = []
  for (const item of items) {
    const lines = await resolveOrderLine(tx, item, ctx, orderDate)
    resolved.push(...lines)
  }
  return resolved
}

/**
 * Prices a single request line into one purchased line plus, when a FREE_GOODS or
 * qualifying BUNDLING promotion applies, an appended zero-priced free-goods line.
 */
async function resolveOrderLine(
  tx: Transaction,
  item: CreateOrderItemInput,
  ctx: OrderContext,
  orderDate: string
): Promise<ResolvedOrderLine[]> {
  const varianId = item.varian_id ?? null
  const rules = await fetchUomRules(tx, item.material_id, ctx.companyId)
  const unitPrice = await resolveUnitPrice(tx, {
    item,
    rules,
    varianId,
    sofficeId: ctx.sofficeId,
    orderDate,
  })

  const promotion = await resolvePromotion(tx, item.promotion_id ?? null, item.qty, ctx.companyId)
  const { discountPercentage, fixedDiscountAmount } = resolveLineDiscount(item.discount_percentage, promotion)
  const pricing = computeLinePricing({ qty: item.qty, unitPrice, discountPercentage, fixedDiscountAmount })

  const purchased: ResolvedOrderLine = {
    materialId: item.material_id,
    qty: item.qty,
    uom: item.uom,
    unitPrice,
    discountPercentage,
    discountAmount: pricing.discountAmount,
    subtotal: pricing.subtotal,
    promotionId: promotion?.id ?? null,
    isFreeGoods: false,
  }

  const lines: ResolvedOrderLine[] = [purchased]
  if (promotionHasFreeGoods(promotion)) {
    lines.push(await buildFreeGoodsLine(tx, promotion!, ctx.companyId))
  }
  return lines
}

/**
 * Builds a zero-priced free-goods line for the promotion's free material, using
 * that material's configured sales UOM. Assumes the caller has already confirmed
 * the promotion carries a free material (via `promotionHasFreeGoods`).
 */
async function buildFreeGoodsLine(
  tx: Transaction,
  promotion: ActivePromotion,
  companyId: string
): Promise<ResolvedOrderLine> {
  const freeMaterialId = promotion.freeMaterialId!
  const salesUom = await fetchSalesUom(tx, freeMaterialId, companyId)

  return {
    materialId: freeMaterialId,
    qty: promotion.freeMaterialQty,
    uom: salesUom,
    unitPrice: 0,
    discountPercentage: 0,
    discountAmount: 0,
    subtotal: 0,
    promotionId: promotion.id,
    isFreeGoods: true,
  }
}

/** Looks up a material's sales UOM within the tenant. */
async function fetchSalesUom(tx: Transaction, materialId: string, companyId: string): Promise<string> {
  const [material] = await tx
    .select({ salesUom: masterMaterial.salesUom })
    .from(masterMaterial)
    .where(and(eq(masterMaterial.id, materialId), eq(masterMaterial.companyId, companyId)))
    .limit(1)

  if (!material) {
    throw new ServiceError('FREE_MATERIAL_NOT_FOUND', `Free-goods material ${materialId} not found`, 422)
  }
  return material.salesUom
}

/** Reads and validates a material's UOM conversion rules JSON. */
async function fetchUomRules(
  tx: Transaction,
  materialId: string,
  companyId: string
): Promise<UOMConversionRules> {
  const [material] = await tx
    .select({ rules: masterMaterial.uomConversionRules })
    .from(masterMaterial)
    .where(and(eq(masterMaterial.id, materialId), eq(masterMaterial.companyId, companyId)))
    .limit(1)

  if (!material) {
    throw new ServiceError('MATERIAL_NOT_FOUND', `Material ${materialId} not found`, 404)
  }
  return material.rules as UOMConversionRules
}

/** Params for regional unit-price resolution. */
interface UnitPriceParams {
  item: CreateOrderItemInput
  rules: UOMConversionRules
  varianId: string | null
  sofficeId: string
  orderDate: string
}

/**
 * Looks up the regional base-UOM price for a material (branch + variant, valid
 * for the order date) and scales it to the requested sales UOM via conversion
 * factors. `price_regular` is expressed per `per` base units.
 */
async function resolveUnitPrice(tx: Transaction, params: UnitPriceParams): Promise<number> {
  const priceRow = await fetchPriceRow(tx, params)
  const pricePerBaseUnit = Number(priceRow.priceRegular) / priceRow.per

  try {
    const baseUnitsPerUom = getUomFactor(params.rules, params.item.uom)
    return roundToPrecision(pricePerBaseUnit * baseUnitsPerUom)
  } catch (err) {
    if (err instanceof UOMConversionError) {
      throw new ServiceError(err.code, err.message, 422)
    }
    throw err
  }
}

/** Fetches the active price row for a material at a branch on a given date. */
async function fetchPriceRow(
  tx: Transaction,
  params: UnitPriceParams
): Promise<{ priceRegular: string; per: number }> {
  const varianCondition = params.varianId
    ? eq(masterPrice.varianId, params.varianId)
    : sql`${masterPrice.varianId} IS NULL`

  const [price] = await tx
    .select({ priceRegular: masterPrice.priceRegular, per: masterPrice.per })
    .from(masterPrice)
    .where(
      and(
        eq(masterPrice.sofficeId, params.sofficeId),
        eq(masterPrice.materialId, params.item.material_id),
        varianCondition,
        lte(masterPrice.validFrom, params.orderDate),
        gte(masterPrice.validTo, params.orderDate)
      )
    )
    .orderBy(sql`${masterPrice.validFrom} DESC`)
    .limit(1)

  if (!price) {
    throw new ServiceError(
      'PRICE_NOT_FOUND',
      `No active price for material ${params.item.material_id} at this branch`,
      422
    )
  }
  return { priceRegular: price.priceRegular, per: price.per ?? 1 }
}

/**
 * Loads an active promotion (any type) and verifies it is not deleted, is active,
 * within its validity window, and that the line qty meets the promotion's minimum.
 */
async function resolvePromotion(
  tx: Transaction,
  promotionId: string | null,
  qty: number,
  companyId: string
): Promise<ActivePromotion | null> {
  if (!promotionId) return null

  const now = new Date().toISOString()
  const [promo] = await tx
    .select({
      id: masterPromotions.id,
      promoType: masterPromotions.promoType,
      discountPercentage: masterPromotions.discountPercentage,
      discountAmount: masterPromotions.discountAmount,
      minOrderQty: masterPromotions.minOrderQty,
      freeMaterialId: masterPromotions.freeMaterialId,
      freeMaterialQty: masterPromotions.freeMaterialQty,
    })
    .from(masterPromotions)
    .where(
      and(
        eq(masterPromotions.id, promotionId),
        eq(masterPromotions.companyId, companyId),
        eq(masterPromotions.isActive, true),
        eq(masterPromotions.isDeleted, false),
        lte(masterPromotions.validStart, now),
        gte(masterPromotions.validEnd, now)
      )
    )
    .limit(1)

  if (!promo) {
    throw new ServiceError('PROMOTION_NOT_FOUND', 'Promotion is invalid or expired', 422)
  }

  const minQty = promo.minOrderQty ?? 1
  if (qty < minQty) {
    throw new ServiceError(
      'PROMOTION_MIN_QTY_NOT_MET',
      `Promotion requires a minimum quantity of ${minQty}`,
      422
    )
  }

  return {
    id: promo.id,
    promoType: promo.promoType,
    discountPercentage: Number(promo.discountPercentage ?? 0),
    discountAmount: Number(promo.discountAmount ?? 0),
    minOrderQty: minQty,
    freeMaterialId: promo.freeMaterialId ?? null,
    freeMaterialQty: promo.freeMaterialQty ?? 0,
  }
}

/** Persists resolved order lines and returns the inserted rows. */
async function insertOrderItems(
  tx: Transaction,
  orderId: string,
  lines: ResolvedOrderLine[]
): Promise<Array<typeof orderItems.$inferSelect>> {
  return tx
    .insert(orderItems)
    .values(
      lines.map((line) => ({
        orderId,
        materialId: line.materialId,
        qty: line.qty,
        uom: line.uom,
        unitPrice: String(line.unitPrice),
        discountPercentage: String(line.discountPercentage),
        discountAmount: String(line.discountAmount),
        subtotal: String(line.subtotal),
        promotionId: line.promotionId,
        isFreeGoods: line.isFreeGoods,
      }))
    )
    .returning()
}

// =============================================================================
// Order Number Generation
// =============================================================================

/**
 * Generates a sequential, per-tenant, per-day order number of the form
 * `ORD-YYYYMMDD-NNNN`. The NNNN suffix comes from an atomic upsert on the
 * `order_sequences` counter (keyed by company_id + order_date), which serializes
 * concurrent order creation on the row lock and returns a gap-free monotonic
 * value. This avoids the duplicate-number race of a COUNT-based approach. Must
 * run inside the caller's RLS-scoped create transaction so the counter write is
 * tenant-isolated and atomic with the order insert.
 */
export async function generateOrderNumber(
  tx: Transaction,
  companyId: string,
  orderDate: string
): Promise<string> {
  const sequence = await nextOrderSequence(tx, companyId, orderDate)
  const datePart = orderDate.replace(/-/g, '')
  return `ORD-${datePart}-${String(sequence).padStart(4, '0')}`
}

/**
 * Atomically increments and returns the tenant's order counter for a date via
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. The first order of the day
 * yields 1; each subsequent (including concurrent) call returns the next integer.
 */
async function nextOrderSequence(
  tx: Transaction,
  companyId: string,
  orderDate: string
): Promise<number> {
  const [row] = await tx
    .insert(orderSequences)
    .values({ companyId, orderDate, lastSequence: 1 })
    .onConflictDoUpdate({
      target: [orderSequences.companyId, orderSequences.orderDate],
      set: {
        lastSequence: sql`${orderSequences.lastSequence} + 1`,
        updatedAt: new Date().toISOString(),
      },
    })
    .returning({ lastSequence: orderSequences.lastSequence })

  if (!row) throw new Error('Order sequence upsert returned no rows')
  return row.lastSequence
}

// =============================================================================
// Order Retrieval
// =============================================================================

/** Fetches a single order (owned by the caller) with its line items. */
export async function getOrderById(
  orderId: string,
  ctx: OrderContext
): Promise<OrderDetailResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    const header = await fetchOwnedOrder(tx, orderId, ctx)
    const items = await fetchOrderItems(tx, orderId)
    return { ...mapOrderRow(header), items }
  })
}

/** Paginated list of the caller's orders with optional filters. */
export async function listOrders(
  params: ListOrdersParams,
  ctx: OrderContext
): Promise<OrderListResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  return withRLS(rlsCtx, async (tx) => {
    const whereClause = and(...buildListConditions(params, ctx))

    const [rows, totalResult] = await Promise.all([
      tx.select().from(orders).where(whereClause).orderBy(sql`${orders.createdAt} DESC`).limit(limit).offset(offset),
      tx.select({ total: count() }).from(orders).where(whereClause),
    ])

    return { data: rows.map(mapOrderRow), meta: { page, limit, total: totalResult[0]?.total ?? 0 } }
  })
}

/** Builds WHERE conditions for the order list query. */
function buildListConditions(params: ListOrdersParams, ctx: OrderContext) {
  const conditions = [eq(orders.companyId, ctx.companyId), eq(orders.userId, ctx.userId)]

  if (params.status) conditions.push(eq(orders.orderStatus, params.status))
  if (params.date_from) conditions.push(gte(orders.orderDate, params.date_from))
  if (params.date_to) conditions.push(lte(orders.orderDate, params.date_to))
  if (params.customer_id) conditions.push(eq(orders.customerId, params.customer_id))

  return conditions
}

// =============================================================================
// Order Submission
// =============================================================================

/**
 * Submits a DRAFT order for ERP sync by transitioning it to SUBMITTED. Verifies
 * tenant ownership and enforces that only DRAFT orders may be submitted. The
 * status transition is written inside an RLS-scoped transaction and the updated
 * header (with line items) is returned.
 */
export async function submitOrder(
  orderId: string,
  ctx: OrderContext
): Promise<OrderDetailResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    const header = await fetchOwnedOrder(tx, orderId, ctx)

    if (header.orderStatus !== 'DRAFT') {
      throw new ServiceError(
        'ORDER_NOT_SUBMITTABLE',
        `Only DRAFT orders can be submitted (current status: ${header.orderStatus})`,
        409
      )
    }

    const [updated] = await tx
      .update(orders)
      .set({ orderStatus: 'SUBMITTED', updatedAt: new Date().toISOString() })
      .where(and(eq(orders.id, orderId), eq(orders.companyId, ctx.companyId)))
      .returning()

    if (!updated) throw new ServiceError('ORDER_NOT_FOUND', 'Order not found', 404)

    const items = await fetchOrderItems(tx, orderId)
    return { ...mapOrderRow(updated), items }
  })
}

// =============================================================================
// PDF Quotation URL
// =============================================================================

/** Pre-signed PDF quotation URL result for GET /orders/:id/pdf. */
export interface OrderPdfUrlResult {
  id: string
  pdf_url: string
  expires_in: number
}

/** Seconds a generated PDF download URL remains valid. */
const PDF_URL_EXPIRES_IN = 3600

/**
 * Returns a pre-signed S3 GET URL for an order's generated PDF quotation. Verifies
 * tenant ownership first, then requires that the PDF has already been generated
 * (i.e., `pdf_quotation_s3_key` is set); otherwise a 404 PDF_NOT_GENERATED error
 * is thrown.
 */
export async function getOrderPdfUrl(
  orderId: string,
  ctx: OrderContext
): Promise<OrderPdfUrlResult> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  const s3Key = await withRLS(rlsCtx, async (tx) => {
    const header = await fetchOwnedOrder(tx, orderId, ctx)
    return header.pdfQuotationS3Key
  })

  if (!s3Key) {
    throw new ServiceError('PDF_NOT_GENERATED', 'PDF quotation has not been generated for this order', 404)
  }

  const pdfUrl = await generateDownloadUrl({ key: s3Key, expiresIn: PDF_URL_EXPIRES_IN })
  return { id: orderId, pdf_url: pdfUrl, expires_in: PDF_URL_EXPIRES_IN }
}

// =============================================================================
// PDF Quotation Generation
// =============================================================================

/**
 * Generates a branded PDF quotation for an owned order and uploads it to S3.
 *
 * Loads the order header, its line items (with material names), the customer, and
 * the tenant's branding within a single RLS-scoped transaction, renders the PDF,
 * uploads the bytes to S3 under the tenant-prefixed quotations key, persists the
 * resulting S3 key onto the order, and returns a fresh pre-signed download URL.
 * The S3 key is never returned to the client.
 */
export async function generateOrderPdf(
  orderId: string,
  ctx: OrderContext
): Promise<OrderPdfUrlResult> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  const s3Key = await withRLS(rlsCtx, async (tx) => {
    const data = await loadQuotationData(tx, orderId, ctx)
    const pdfBytes = await renderQuotationPdf(data)
    const key = buildS3Key({
      companyId: ctx.companyId,
      category: 'orders/quotations',
      fileId: randomUUID(),
      extension: 'pdf',
    })
    await uploadObject({ key, body: pdfBytes, contentType: 'application/pdf' })
    await persistPdfKey(tx, orderId, ctx.companyId, key)
    return key
  })

  const pdfUrl = await generateDownloadUrl({ key: s3Key, expiresIn: PDF_URL_EXPIRES_IN })
  return { id: orderId, pdf_url: pdfUrl, expires_in: PDF_URL_EXPIRES_IN }
}

/** Assembles the quotation view model from the order, its items, customer, and tenant branding. */
async function loadQuotationData(
  tx: Transaction,
  orderId: string,
  ctx: OrderContext
): Promise<QuotationData> {
  const header = await fetchOwnedOrder(tx, orderId, ctx)
  const [lines, customerName, branding] = await Promise.all([
    loadQuotationLines(tx, orderId),
    fetchCustomerName(tx, header.customerId, ctx.companyId),
    fetchBranding(tx, ctx.companyId),
  ])

  return {
    branding,
    orderNumber: header.orderNumber,
    orderDate: header.orderDate,
    customerName,
    lines,
    subtotalAmount: Number(header.subtotalAmount),
    totalDiscountAmount: Number(header.totalDiscountAmount ?? 0),
    taxAmount: Number(header.taxAmount),
    grandTotal: Number(header.grandTotal),
  }
}

/** Loads order line items joined to their material names, ordered by insertion. */
async function loadQuotationLines(tx: Transaction, orderId: string): Promise<QuotationLine[]> {
  const rows = await tx
    .select({
      materialName: masterMaterial.name,
      qty: orderItems.qty,
      uom: orderItems.uom,
      unitPrice: orderItems.unitPrice,
      discountPercentage: orderItems.discountPercentage,
      subtotal: orderItems.subtotal,
      isFreeGoods: orderItems.isFreeGoods,
    })
    .from(orderItems)
    .innerJoin(masterMaterial, eq(orderItems.materialId, masterMaterial.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(sql`${orderItems.createdAt} ASC`)

  return rows.map((row) => ({
    materialName: row.materialName,
    qty: row.qty,
    uom: row.uom,
    unitPrice: Number(row.unitPrice),
    discountPercentage: Number(row.discountPercentage ?? 0),
    subtotal: Number(row.subtotal),
    isFreeGoods: row.isFreeGoods ?? false,
  }))
}

/** Looks up the customer's display name within the tenant. */
async function fetchCustomerName(tx: Transaction, customerId: string, companyId: string): Promise<string> {
  const [customer] = await tx
    .select({ name: masterCustomer.name })
    .from(masterCustomer)
    .where(and(eq(masterCustomer.id, customerId), eq(masterCustomer.companyId, companyId)))
    .limit(1)

  if (!customer) {
    throw new ServiceError('CUSTOMER_NOT_FOUND', `Customer ${customerId} not found`, 422)
  }
  return customer.name
}

/** Reads tenant branding (company name + tax rate) for the quotation header. */
async function fetchBranding(tx: Transaction, companyId: string): Promise<QuotationData['branding']> {
  const [company] = await tx
    .select({ name: companies.name, defaultTaxRate: companies.defaultTaxRate })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)

  if (!company) {
    throw new ServiceError('COMPANY_NOT_FOUND', 'Tenant company not found', 404)
  }
  return {
    companyName: company.name,
    taxRate: company.defaultTaxRate != null ? Number(company.defaultTaxRate) : 11,
  }
}

/** Persists the generated PDF's S3 key onto the order header. */
async function persistPdfKey(
  tx: Transaction,
  orderId: string,
  companyId: string,
  s3Key: string
): Promise<void> {
  await tx
    .update(orders)
    .set({ pdfQuotationS3Key: s3Key, updatedAt: new Date().toISOString() })
    .where(and(eq(orders.id, orderId), eq(orders.companyId, companyId)))
}

// =============================================================================
// Internal Helpers
// =============================================================================

/** Formats today's date as YYYY-MM-DD. */
function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0]!
}

/** Rounds a computed unit price to 2 decimal places (numeric(15,2)). */
function roundToPrecision(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** Reads the tenant's configured default tax rate (PPN), defaulting to 11%. */
async function getDefaultTaxRate(tx: Transaction, companyId: string): Promise<number> {
  const [company] = await tx
    .select({ defaultTaxRate: companies.defaultTaxRate })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)

  return company?.defaultTaxRate != null ? Number(company.defaultTaxRate) : 11
}

/** Fetches an order and verifies tenant + ownership. */
async function fetchOwnedOrder(
  tx: Transaction,
  orderId: string,
  ctx: OrderContext
): Promise<typeof orders.$inferSelect> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.companyId, ctx.companyId)))
    .limit(1)

  if (!order) throw new ServiceError('ORDER_NOT_FOUND', 'Order not found', 404)
  if (order.userId !== ctx.userId) {
    throw new ServiceError('ORDER_NOT_OWNED', 'You do not have access to this order', 403)
  }
  return order
}

/** Fetches all line items for an order. */
async function fetchOrderItems(tx: Transaction, orderId: string): Promise<OrderItemResponseType[]> {
  const rows = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(sql`${orderItems.createdAt} ASC`)

  return rows.map(mapOrderItemRow)
}

/** Maps an order header Drizzle row to the API response shape. */
function mapOrderRow(row: typeof orders.$inferSelect): OrderResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    soffice_id: row.sofficeId,
    user_id: row.userId,
    customer_id: row.customerId,
    doctor_customer_id: row.doctorCustomerId ?? null,
    visit_id: row.visitId ?? null,
    order_number: row.orderNumber,
    erp_quotation_number: row.erpQuotationNumber ?? null,
    order_date: row.orderDate,
    subtotal_amount: Number(row.subtotalAmount),
    total_discount_amount: Number(row.totalDiscountAmount ?? 0),
    tax_rate: Number(row.taxRate ?? 11),
    tax_amount: Number(row.taxAmount),
    grand_total: Number(row.grandTotal),
    order_status: (row.orderStatus ?? 'DRAFT') as OrderResponseType['order_status'],
    erp_sync_timestamp: row.erpSyncTimestamp ?? null,
    pdf_quotation_s3_key: row.pdfQuotationS3Key ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

/** Maps an order item Drizzle row to the API response shape. */
function mapOrderItemRow(row: typeof orderItems.$inferSelect): OrderItemResponseType {
  return {
    id: row.id,
    order_id: row.orderId,
    material_id: row.materialId,
    qty: row.qty,
    uom: row.uom,
    unit_price: Number(row.unitPrice),
    discount_percentage: Number(row.discountPercentage ?? 0),
    discount_amount: Number(row.discountAmount ?? 0),
    subtotal: Number(row.subtotal),
    promotion_id: row.promotionId ?? null,
    is_free_goods: row.isFreeGoods ?? false,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/** Re-exported for consumers that need base-unit conversion (e.g., ERP payloads). */
export { convertToBaseUnits }

/** Re-exported promotion resolution API (implemented in ./promotion). */
export { resolveDiscountPercentage, resolveLineDiscount, promotionHasFreeGoods }
export type { ActivePromotion }
