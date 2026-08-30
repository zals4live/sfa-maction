import { eq, and, gte, lte, desc, count, sql, type SQL } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { orders, orderItems } from '../../db/schema/order'
import { masterMaterial } from '../../db/schema/material'
import type { OrderRegisterParams, OrderRegisterResponseType } from './schemas'

/**
 * Order/quotation transaction register query over the `orders` table
 * (FR-REP order register). Powers `GET /reports/orders`.
 *
 * Tenant isolation is enforced twice: every query filters on
 * `company_id = ctx.companyId` AND runs inside the RLS-scoped transaction
 * (`app.current_company_id` session var). The `orders` RLS policy additionally
 * restricts row visibility by role — SALESMAN sees only their own orders,
 * admins see all tenant orders, MR is barred entirely — so no role branching
 * is needed in the query itself.
 *
 * Optional, composable filters narrow by salesman, branch, customer, order
 * status, an inclusive `order_date` range, min/max grand total, and business
 * line (lini). Lini is not stored on `orders`; it is derived per-order via an
 * EXISTS sub-query joining `order_items` to `master_material.lini_id`. Varian
 * is not persisted on orders/order_items and is therefore not filterable.
 *
 * Results are paginated (LIMIT/OFFSET) and ordered newest-first by
 * `order_date` with a stable tiebreak on `id`. Response field names are
 * snake_case (`OrderRegisterRowSchema`) and differ from the camelCase Drizzle
 * columns; numeric string columns are coerced to numbers.
 */

/** A single order register row (matches OrderRegisterRowSchema). */
type OrderRegisterRow = OrderRegisterResponseType['data'][number]

/** Minimal DB projection needed to build an order register row. */
export interface OrderRecord {
  orderId: string
  orderNumber: string
  userId: string
  customerId: string
  sofficeId: string
  status: string | null
  totalAmount: string | null
  createdAt: string | null
}

/** Default order status when the nullable column is null. */
const DEFAULT_STATUS = 'DRAFT'

/**
 * Builds the WHERE conditions for the order register query. Always scopes to
 * the tenant; optional filters narrow by salesman, branch, customer, status,
 * order-date range, grand-total bounds, and business line (lini).
 */
export function buildOrderConditions(params: OrderRegisterParams, companyId: string): SQL[] {
  const conditions: SQL[] = [eq(orders.companyId, companyId)]

  if (params.user_id) conditions.push(eq(orders.userId, params.user_id))
  if (params.soffice_id) conditions.push(eq(orders.sofficeId, params.soffice_id))
  if (params.customer_id) conditions.push(eq(orders.customerId, params.customer_id))
  if (params.status) conditions.push(eq(orders.orderStatus, params.status))
  if (params.date_from) conditions.push(gte(orders.orderDate, params.date_from))
  if (params.date_to) conditions.push(lte(orders.orderDate, params.date_to))
  if (params.min_total !== undefined) conditions.push(gte(orders.grandTotal, String(params.min_total)))
  if (params.max_total !== undefined) conditions.push(lte(orders.grandTotal, String(params.max_total)))
  if (params.lini_id) conditions.push(buildLiniCondition(params.lini_id))

  return conditions
}

/**
 * Correlated EXISTS predicate matching orders that contain at least one item
 * whose material belongs to the given business line (lini). Built with the
 * Drizzle `sql` tag using bound parameters (`${...}`) — no string
 * interpolation, so the lini id is passed as a query parameter.
 */
function buildLiniCondition(liniId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${orderItems}
    INNER JOIN ${masterMaterial} ON ${masterMaterial.id} = ${orderItems.materialId}
    WHERE ${orderItems.orderId} = ${orders.id}
      AND ${masterMaterial.liniId} = ${liniId}
  )`
}

/** Resolves the effective page/limit and derived LIMIT/OFFSET for pagination. */
export function resolvePagination(params: OrderRegisterParams): {
  page: number
  limit: number
  offset: number
} {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  return { page, limit, offset: (page - 1) * limit }
}

/** Maps a raw order record to the snake_case response row shape. */
export function mapOrderRow(record: OrderRecord): OrderRegisterRow {
  return {
    order_id: record.orderId,
    order_number: record.orderNumber,
    user_id: record.userId,
    customer_id: record.customerId,
    soffice_id: record.sofficeId,
    status: record.status ?? DEFAULT_STATUS,
    total_amount: toNumber(record.totalAmount),
    created_at: toIsoString(record.createdAt),
  }
}

/** Coerces a numeric string column to a number, defaulting to 0. */
function toNumber(value: string | null): number {
  if (value === null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Normalizes a DB timestamp (string) to an ISO date-time string. */
function toIsoString(value: string | null): string {
  if (!value) return new Date(0).toISOString()
  return new Date(value).toISOString()
}

/** Fetches the total count of matching orders (for pagination meta). */
export async function fetchOrderTotal(tx: Transaction, conditions: SQL[]): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(orders)
    .where(and(...conditions))

  return row?.total ?? 0
}

/** Fetches a page of matching orders, newest-first with a stable tiebreak. */
export async function fetchOrderPage(
  tx: Transaction,
  conditions: SQL[],
  limit: number,
  offset: number
): Promise<OrderRegisterRow[]> {
  const rows = await tx
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      userId: orders.userId,
      customerId: orders.customerId,
      sofficeId: orders.sofficeId,
      status: orders.orderStatus,
      totalAmount: orders.grandTotal,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.orderDate), desc(orders.id))
    .limit(limit)
    .offset(offset)

  return rows.map(mapOrderRow)
}
