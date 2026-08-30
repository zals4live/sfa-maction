import { withRLS, type RLSContext } from '../../db'
import type {
  DashboardKpiParams,
  BranchPerformanceParams,
  CallRateParams,
  OrderRegisterParams,
  FraudIncidentParams,
  ExportPathParams,
  ExportQueryParams,
  DashboardKpiResponseType,
  BranchPerformanceResponseType,
  CallRateReportResponseType,
  OrderRegisterResponseType,
  FraudIncidentResponseType,
} from './schemas'
import {
  fetchBranchHeadlineTotals,
  fetchRoleVisitMetrics,
  resolvePeriodDays,
} from './dashboardKpi'
import {
  fetchBranchTotals,
  fetchBranchRoleMetrics,
  buildBranchPerformanceMatrix,
} from './branchPerformance'
import {
  buildDashboardKpiCacheKey,
  buildBranchPerformanceCacheKey,
  buildCallRateCacheKey,
  resolveDashboardCacheTtl,
} from './dashboardCache'
import {
  fetchCallRateUsers,
  fetchPlannedCounts,
  fetchVisitedCounts,
  buildCallRateRows,
  resolveMonthRange,
} from './callRate'
import {
  buildFraudConditions,
  resolvePagination,
  fetchFraudTotal,
  fetchFraudPage,
} from './fraudIncidents'
import {
  buildOrderConditions,
  resolvePagination as resolveOrderPagination,
  fetchOrderTotal,
  fetchOrderPage,
} from './orderRegister'
import { cached } from '../../lib/cache'
import { buildExportFilename, XLSX_CONTENT_TYPE } from '@maction/utils'
import {
  buildDashboardKpiTable,
  buildBranchPerformanceTable,
  buildCallRateTable,
  buildOrderRegisterTable,
  buildFraudIncidentTable,
  serializeWorkbook,
} from './excelExport'
import type { WorksheetTable } from '@maction/utils'

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

/** Context required for report operations (derived from JWT claims). */
export interface ReportContext {
  companyId: string
  userId: string
  userRole: string
}

/** Builds the RLS context object from a report context. */
function toRLSContext(ctx: ReportContext): RLSContext {
  return { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }
}

/**
 * Executive dashboard KPI, segmented by Salesman vs MR.
 *
 * Branch-level headline totals (active users, orders, revenue) come from
 * `mv_daily_branch_performance`; the per-role visit/call-rate segmentation is
 * derived from `mv_user_territory_performance` (which carries `role_label`).
 * See dashboardKpi.ts for the full segmentation rationale. Both queries run in
 * a single RLS-scoped transaction for tenant isolation.
 *
 * Responses are cached in Redis (cache-aside) under a tenant- and
 * parameter-scoped key with a 5–15 min TTL. Redis failures degrade gracefully
 * to a fresh computation — see lib/cache.ts and dashboardCache.ts.
 */
export async function getDashboardKpi(
  params: DashboardKpiParams,
  ctx: ReportContext
): Promise<DashboardKpiResponseType> {
  const key = buildDashboardKpiCacheKey(ctx.companyId, params)
  return cached(key, resolveDashboardCacheTtl(), () => computeDashboardKpi(params, ctx))
}

/** Computes the fresh dashboard KPI from the materialized views (cache miss path). */
async function computeDashboardKpi(
  params: DashboardKpiParams,
  ctx: ReportContext
): Promise<DashboardKpiResponseType> {
  const period = params.period ?? 'month'
  const days = resolvePeriodDays(period)
  const sofficeId = params.soffice_id ?? null

  const { totals, roles } = await withRLS(toRLSContext(ctx), async (tx) => {
    const [totals, roles] = await Promise.all([
      fetchBranchHeadlineTotals(tx, ctx.companyId, days, sofficeId),
      fetchRoleVisitMetrics(tx, ctx.companyId, days, sofficeId),
    ])
    return { totals, roles }
  })

  return {
    data: {
      period,
      total_active_users: totals.total_active_users,
      total_orders: totals.total_orders,
      total_revenue: totals.total_revenue,
      SALESMAN: roles.SALESMAN,
      MR: roles.MR,
    },
    meta: {
      soffice_id: sofficeId,
      generated_at: new Date().toISOString(),
    },
  }
}

/**
 * Branch performance matrix ranked by revenue, visits, and strike rate, with
 * Salesman-vs-MR segmentation per branch (FR-REP-02).
 *
 * Branch headline totals come from `mv_daily_branch_performance`; the per-role
 * segmentation is derived from `mv_user_territory_performance`. See
 * branchPerformance.ts for the full ranking/segmentation rationale. Responses
 * are cached in Redis (cache-aside) under a tenant- and month-scoped key with
 * a 5–15 min TTL, degrading gracefully on Redis failure.
 */
export async function getBranchPerformance(
  params: BranchPerformanceParams,
  ctx: ReportContext
): Promise<BranchPerformanceResponseType> {
  const key = buildBranchPerformanceCacheKey(ctx.companyId, params)
  return cached(key, resolveDashboardCacheTtl(), () => computeBranchPerformance(params, ctx))
}

/** Computes the fresh branch performance matrix (cache miss path). */
async function computeBranchPerformance(
  params: BranchPerformanceParams,
  ctx: ReportContext
): Promise<BranchPerformanceResponseType> {
  const { month, year } = params

  const rows = await withRLS(toRLSContext(ctx), async (tx) => {
    const [totals, roleRows] = await Promise.all([
      fetchBranchTotals(tx, ctx.companyId, month, year),
      fetchBranchRoleMetrics(tx, ctx.companyId, month, year),
    ])
    return buildBranchPerformanceMatrix(totals, roleRows)
  })

  return {
    data: rows,
    meta: { month, year, total_branches: rows.length },
  }
}

/**
 * Call rate report aggregating planned-vs-visited per field user for a calendar
 * month (FR-SCP call-rate analytics), at user / branch / tenant level with an
 * optional role filter.
 *
 * Scope is controlled by the query params: `user_id` narrows to a single user,
 * `soffice_id` to a branch, and their absence yields tenant-level aggregation
 * across all active SALESMAN/MR users. Planned counts come from `visit_plans`
 * and visited counts from completed `visits` (`visit_out_at IS NOT NULL`); the
 * call rate reuses the tested `calculateCallRate` helper. All queries run in a
 * single RLS-scoped transaction for tenant isolation.
 *
 * Responses are cached in Redis (cache-aside) under a tenant- and
 * parameter-scoped key with a 5–15 min TTL, degrading gracefully on Redis
 * failure — see lib/cache.ts and dashboardCache.ts.
 */
export async function getCallRateReport(
  params: CallRateParams,
  ctx: ReportContext
): Promise<CallRateReportResponseType> {
  const key = buildCallRateCacheKey(ctx.companyId, params)
  return cached(key, resolveDashboardCacheTtl(), () => computeCallRateReport(params, ctx))
}

/** Computes the fresh call-rate report (cache miss path). */
async function computeCallRateReport(
  params: CallRateParams,
  ctx: ReportContext
): Promise<CallRateReportResponseType> {
  const { month, year } = params
  const { startDate, endDate } = resolveMonthRange(params)

  const rows = await withRLS(toRLSContext(ctx), async (tx) => {
    const users = await fetchCallRateUsers(tx, params, ctx.companyId)
    if (users.length === 0) return []

    const userIds = users.map((u) => u.id)
    const [plannedCounts, visitedCounts] = await Promise.all([
      fetchPlannedCounts(tx, ctx.companyId, userIds, startDate, endDate),
      fetchVisitedCounts(tx, ctx.companyId, userIds, startDate, endDate),
    ])

    return buildCallRateRows(users, plannedCounts, visitedCounts)
  })

  return {
    data: rows,
    meta: { month, year, total_users: rows.length },
  }
}

/**
 * Order/quotation transaction register with multi-variable filtering
 * (FR-REP order register). Powers the `GET /reports/orders` endpoint.
 *
 * Scope is controlled by composable, all-optional query params: salesman
 * (`user_id`), branch (`soffice_id`), `customer_id`, order `status`, an
 * inclusive `order_date` range (`date_from` / `date_to`), grand-total bounds
 * (`min_total` / `max_total`), and business line (`lini_id`, matched via an
 * EXISTS sub-query over `order_items` → `master_material`). Results are ordered
 * newest-first and paginated via LIMIT/OFFSET.
 *
 * Tenant AND role isolation are enforced by the `orders` RLS policy plus the
 * `company_id` filter — SALESMAN sees only their own orders, admins see all
 * tenant orders, MR is barred at the DB level. The count and page queries run
 * in a single RLS-scoped transaction. See orderRegister.ts for query rationale.
 */
export async function getOrderRegister(
  params: OrderRegisterParams,
  ctx: ReportContext
): Promise<OrderRegisterResponseType> {
  const { page, limit, offset } = resolveOrderPagination(params)
  const conditions = buildOrderConditions(params, ctx.companyId)

  const { data, total } = await withRLS(toRLSContext(ctx), async (tx) => {
    const [total, data] = await Promise.all([
      fetchOrderTotal(tx, conditions),
      fetchOrderPage(tx, conditions, limit, offset),
    ])
    return { data, total }
  })

  return {
    data,
    meta: { page, limit, total },
  }
}

/**
 * Paginated fraud telemetry incidents from `audit_fraud_telemetry` for the
 * ADMIN-only fraud review register (route gated by requireRole ADMIN_ONLY).
 *
 * Scope is controlled by the query params: `user_id`, `fraud_type`, and an
 * inclusive `created_at` date range (`date_from` / `date_to`). Results are
 * ordered newest-first with a stable tiebreak on `id` and paginated via
 * LIMIT/OFFSET. Tenant isolation is enforced both by the `company_id` filter
 * and the RLS session var. The count and page queries run in a single
 * RLS-scoped transaction. See fraudIncidents.ts for the query rationale.
 */
export async function getFraudIncidents(
  params: FraudIncidentParams,
  ctx: ReportContext
): Promise<FraudIncidentResponseType> {
  const { page, limit, offset } = resolvePagination(params)
  const conditions = buildFraudConditions(params, ctx.companyId)

  const { data, total } = await withRLS(toRLSContext(ctx), async (tx) => {
    const [total, data] = await Promise.all([
      fetchFraudTotal(tx, conditions),
      fetchFraudPage(tx, conditions, limit, offset),
    ])
    return { data, total }
  })

  return {
    data,
    meta: { page, limit, total },
  }
}

/** A ready-to-stream binary export payload (headers + body). */
export interface BinaryExport {
  body: Buffer
  filename: string
  contentType: string
}

/** Ensures month/year are present for calendar-scoped reports. */
function assertMonthYear(query: ExportQueryParams): { month: number; year: number } {
  if (query.month === undefined || query.year === undefined) {
    throw new ServiceError(
      'MISSING_PARAMETER',
      `Report '${query.report}' requires 'month' and 'year' query parameters`,
      400
    )
  }
  return { month: query.month, year: query.year }
}

/**
 * Fetch the requested report via the existing RLS-scoped service functions and
 * flatten it into a worksheet table. Each branch reuses the tested query path,
 * so tenant/role isolation is preserved end-to-end.
 */
async function buildReportTable(
  query: ExportQueryParams,
  ctx: ReportContext
): Promise<WorksheetTable> {
  switch (query.report) {
    case 'dashboard-kpi':
      return buildDashboardKpiTable(
        await getDashboardKpi({ soffice_id: query.soffice_id }, ctx)
      )
    case 'branch-performance':
      return buildBranchPerformanceTable(
        await getBranchPerformance(assertMonthYear(query), ctx)
      )
    case 'call-rate':
      return buildCallRateTable(await getCallRateReport(assertMonthYear(query), ctx))
    case 'orders':
      return buildOrderRegisterTable(await getOrderRegister({ soffice_id: query.soffice_id }, ctx))
    case 'fraud-incidents':
      return buildFraudIncidentTable(await getFraudIncidents({}, ctx))
    default:
      throw new ServiceError('UNKNOWN_REPORT', `Unknown report '${query.report}'`, 400)
  }
}

/**
 * Prepares a streaming binary export. Only `.xlsx` is implemented here; the PDF
 * executive summary export is a separate Phase 11 task and still returns
 * NOT_IMPLEMENTED. The `.xlsx` path fetches the report under RLS, flattens it to
 * a worksheet, and serializes it off the critical path (see excelExport.ts).
 */
export async function prepareExport(
  params: ExportPathParams,
  query: ExportQueryParams,
  ctx: ReportContext
): Promise<BinaryExport> {
  if (params.type !== 'xlsx') {
    throw new ServiceError(
      'NOT_IMPLEMENTED',
      `Streaming ${params.type} export for '${query.report}' is not yet available`,
      501
    )
  }

  const table = await buildReportTable(query, ctx)
  const body = await serializeWorkbook(table, query.report)
  return {
    body,
    filename: buildExportFilename(query.report, 'xlsx'),
    contentType: XLSX_CONTENT_TYPE,
  }
}
