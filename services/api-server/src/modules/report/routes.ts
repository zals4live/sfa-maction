import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ADMIN_ONLY, ORDER_READERS } from '../../middleware/roleGuard'
import {
  DashboardKpiQuery,
  BranchPerformanceQuery,
  CallRateQuery,
  OrderRegisterQuery,
  FraudIncidentQuery,
  ExportParams,
  ExportQuery,
} from './schemas'
import {
  getDashboardKpi,
  getBranchPerformance,
  getCallRateReport,
  getOrderRegister,
  getFraudIncidents,
  prepareExport,
  ServiceError,
  type ReportContext,
} from './service'
import type { JWTClaims } from '../../middleware/tenantGuard'

/** Builds the report service context from validated JWT claims. */
function toContext(claims: JWTClaims): ReportContext {
  return {
    companyId: claims.company_id,
    userId: claims.user_id,
    userRole: claims.role_label,
  }
}

/** Maps a ServiceError to a structured API error response and status. */
function toErrorResponse(
  err: unknown,
  set: { status?: number | string }
): { error: { code: string; message: string } } {
  if (err instanceof ServiceError) {
    set.status = err.status
    return { error: { code: err.code, message: err.message } }
  }
  throw err
}

/**
 * Order/quotation transaction register — gated to ORDER_READERS (SALESMAN +
 * admin roles) rather than ADMIN_ONLY, so a SALESMAN can view their own orders
 * (row visibility further narrowed by the `orders` RLS policy). MR is excluded.
 * Mounted as a sibling group so its role guard does not affect the other,
 * admin-only report endpoints.
 */
const orderRegisterRoutes = new Elysia({ prefix: '/reports' })
  .use(tenantGuard)
  .use(requireRole(...ORDER_READERS))
  .get(
    '/orders',
    async ({ query, claims, set }) => {
      try {
        return await getOrderRegister(query, toContext(claims!))
      } catch (err) {
        return toErrorResponse(err, set)
      }
    },
    { query: OrderRegisterQuery }
  )

const adminReportRoutes = new Elysia({ prefix: '/reports' })
  .use(tenantGuard)
  .use(requireRole(...ADMIN_ONLY))
  .get(
    '/dashboard-kpi',
    async ({ query, claims, set }) => {
      try {
        return await getDashboardKpi(query, toContext(claims!))
      } catch (err) {
        return toErrorResponse(err, set)
      }
    },
    { query: DashboardKpiQuery }
  )
  .get(
    '/branch-performance',
    async ({ query, claims, set }) => {
      try {
        return await getBranchPerformance(query, toContext(claims!))
      } catch (err) {
        return toErrorResponse(err, set)
      }
    },
    { query: BranchPerformanceQuery }
  )
  .get(
    '/call-rate',
    async ({ query, claims, set }) => {
      try {
        return await getCallRateReport(query, toContext(claims!))
      } catch (err) {
        return toErrorResponse(err, set)
      }
    },
    { query: CallRateQuery }
  )
  .get(
    '/fraud-incidents',
    async ({ query, claims, set }) => {
      try {
        return await getFraudIncidents(query, toContext(claims!))
      } catch (err) {
        return toErrorResponse(err, set)
      }
    },
    { query: FraudIncidentQuery }
  )
  .get(
    '/export/:type',
    async ({ params, query, claims, set }) => {
      try {
        const result = await prepareExport(params, query, toContext(claims!))
        return new Response(new Uint8Array(result.body), {
          headers: {
            'content-type': result.contentType,
            'content-disposition': `attachment; filename="${result.filename}"`,
          },
        })
      } catch (err) {
        return toErrorResponse(err, set)
      }
    },
    { params: ExportParams, query: ExportQuery }
  )

/**
 * Composed report routes: the admin-only reports plus the ORDER_READERS-gated
 * order register, mounted under a shared parent so `index.ts` keeps using a
 * single `reportRoutes` plugin.
 */
export const reportRoutes = new Elysia()
  .use(adminReportRoutes)
  .use(orderRegisterRoutes)
