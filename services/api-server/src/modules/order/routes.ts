import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, SALESMAN_ONLY, ORDER_READERS } from '../../middleware/roleGuard'
import {
  CreateOrderBody,
  ListOrdersQuery,
  OrderIdParams,
  SubmitOrderParams,
} from './schemas'
import {
  createOrder,
  getOrderById,
  listOrders,
  submitOrder,
  getOrderPdfUrl,
  generateOrderPdf,
  ServiceError,
} from './service'

/** Builds the OrderContext from JWT claims. */
function buildCtx(claims: {
  company_id: string
  user_id: string
  soffice_id: string
  role_label: string
}) {
  return {
    companyId: claims.company_id,
    userId: claims.user_id,
    sofficeId: claims.soffice_id,
    userRole: claims.role_label,
  }
}

/**
 * Order write routes — create, submit, and PDF quotation download.
 *
 * Gated to `SALESMAN` only. Any other role, notably `MR`, receives a structured
 * `403 Forbidden` from the role guard. `GET /orders/:id/pdf` is treated as a
 * write-equivalent per the security policy (order-taking surface).
 */
const orderWriteRoutes = new Elysia()
  .use(tenantGuard)
  .use(requireRole(...SALESMAN_ONLY))
  // --- Create a new DRAFT order ---
  .post(
    '/',
    async ({ body, claims, set }) => {
      try {
        const result = await createOrder(body, buildCtx(claims!))
        set.status = 201
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: CreateOrderBody }
  )
  // --- Submit a DRAFT order for ERP sync (DRAFT → SUBMITTED) ---
  .post(
    '/:id/submit',
    async ({ params, claims, set }) => {
      try {
        const result = await submitOrder(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: SubmitOrderParams }
  )
  // --- Generate the branded PDF quotation, upload to S3, return download URL ---
  .post(
    '/:id/pdf',
    async ({ params, claims, set }) => {
      try {
        const result = await generateOrderPdf(params.id, buildCtx(claims!))
        set.status = 201
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: OrderIdParams }
  )
  // --- Pre-signed S3 GET URL for an already-generated PDF quotation ---
  .get(
    '/:id/pdf',
    async ({ params, claims, set }) => {
      try {
        const result = await getOrderPdfUrl(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: OrderIdParams }
  )

/**
 * Order read routes — list and detail.
 *
 * Gated to `SALESMAN` + admin roles so branch/tenant admins can review and
 * approve orders; `MR` remains excluded from all order access and receives a
 * `403 Forbidden`. Row-level tenant/ownership isolation is additionally
 * enforced in the service layer via RLS.
 */
const orderReadRoutes = new Elysia()
  .use(tenantGuard)
  .use(requireRole(...ORDER_READERS))
  // --- Paginated order list (already returns { data, meta }) ---
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await listOrders(query, buildCtx(claims!))
      return result
    },
    { query: ListOrdersQuery }
  )
  // --- Single order detail with line items ---
  .get(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        const result = await getOrderById(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: OrderIdParams }
  )

/**
 * Orders module — mounts the SALESMAN-only write routes and the
 * SALESMAN + admin read routes under the shared `/orders` prefix.
 */
export const orderRoutes = new Elysia({ prefix: '/orders' })
  .use(orderWriteRoutes)
  .use(orderReadRoutes)
