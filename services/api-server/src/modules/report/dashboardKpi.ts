import { sql } from 'drizzle-orm'

import type { Transaction } from '../../db'

/**
 * Dashboard KPI aggregation from the reporting materialized views.
 *
 * Segmentation strategy (Salesman vs MR):
 *   `mv_daily_branch_performance` is the primary dashboard view, but it
 *   aggregates across ALL field users per branch/day and does NOT carry a
 *   `role_label` column — so it cannot, by itself, produce a Salesman-vs-MR
 *   breakdown. It IS the correct source for the branch-level headline totals
 *   (active field users, orders, revenue) which are role-agnostic.
 *
 *   The per-role visit/call-rate segmentation is therefore derived from the
 *   role-carrying view `mv_user_territory_performance`, which stores
 *   `role_label`, `total_visits`, `completed_visits`, and `total_orders` per
 *   user per month. We aggregate that view's rows into SALESMAN and MR blocks.
 *
 *   Both views are queried inside the same RLS-scoped transaction, so tenant
 *   isolation is enforced by the `mv_*` company_id filter plus the session
 *   `app.current_company_id` set by withRLS(). All values are parameterized.
 */

/** Number of days covered by each supported aggregation period. */
const PERIOD_DAYS: Record<string, number> = {
  today: 1,
  week: 7,
  month: 30,
}

/** Branch-level headline totals sourced from mv_daily_branch_performance. */
export interface BranchHeadlineTotals {
  total_active_users: number
  total_orders: number
  total_revenue: number
}

/** Per-role visit metrics sourced from mv_user_territory_performance. */
export interface RoleVisitMetrics {
  total_visits: number
  effective_calls: number
  call_rate_pct: number
}

/** Row shape returned by the branch headline query. */
interface HeadlineRow {
  total_active_users: number | string | null
  total_orders: number | string | null
  total_revenue: number | string | null
}

/** Row shape returned by the per-role territory aggregation query. */
interface RoleRow {
  role_label: string
  total_visits: number | string | null
  effective_calls: number | string | null
}

/** Coerces a DB numeric/decimal (which may arrive as string) to a number. */
export function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(parsed) ? parsed : 0
}

/** Resolves the number of days in the requested aggregation window. */
export function resolvePeriodDays(period: string | undefined): number {
  return PERIOD_DAYS[period ?? 'month'] ?? PERIOD_DAYS['month']!
}

/**
 * Computes a call rate percentage: (effective calls / total visits) × 100.
 * Returns 0 when there are no visits to avoid division by zero.
 */
export function computeCallRate(effectiveCalls: number, totalVisits: number): number {
  if (totalVisits <= 0) return 0
  return Math.round((effectiveCalls / totalVisits) * 10000) / 100
}

/**
 * Queries branch-level headline totals from mv_daily_branch_performance for
 * the window [today - (days - 1), today], optionally scoped to one branch.
 */
export async function fetchBranchHeadlineTotals(
  tx: Transaction,
  companyId: string,
  days: number,
  sofficeId: string | null
): Promise<BranchHeadlineTotals> {
  const result = await tx.execute(
    sql`SELECT
      COALESCE(MAX(mv.total_field_users), 0) AS total_active_users,
      COALESCE(SUM(mv.total_orders), 0) AS total_orders,
      COALESCE(SUM(mv.total_revenue), 0) AS total_revenue
    FROM mv_daily_branch_performance mv
    WHERE mv.company_id = ${companyId}
      AND mv.report_date >= (CURRENT_DATE - MAKE_INTERVAL(days => ${days - 1}))
      AND mv.report_date <= CURRENT_DATE
      AND (${sofficeId}::uuid IS NULL OR mv.soffice_id = ${sofficeId}::uuid)`
  )

  const row = (result as unknown as HeadlineRow[])[0]
  return {
    total_active_users: toNumber(row?.total_active_users),
    total_orders: toNumber(row?.total_orders),
    total_revenue: toNumber(row?.total_revenue),
  }
}

/**
 * Aggregates per-role (SALESMAN / MR) visit metrics from
 * mv_user_territory_performance for months overlapping the requested window.
 *
 * `mv_user_territory_performance` is bucketed by month, so we include any
 * month whose start falls within the window's month boundaries. This yields
 * the role-segmented `total_visits` and effective-call figures that the
 * branch MV cannot provide.
 */
export async function fetchRoleVisitMetrics(
  tx: Transaction,
  companyId: string,
  days: number,
  sofficeId: string | null
): Promise<Record<'SALESMAN' | 'MR', RoleVisitMetrics>> {
  const result = await tx.execute(
    sql`SELECT
      mv.role_label,
      COALESCE(SUM(mv.total_visits), 0) AS total_visits,
      COALESCE(SUM(mv.total_orders), 0) AS effective_calls
    FROM mv_user_territory_performance mv
    WHERE mv.company_id = ${companyId}
      AND mv.role_label IN ('SALESMAN', 'MR')
      AND mv.performance_month >= DATE_TRUNC('month', CURRENT_DATE - MAKE_INTERVAL(days => ${days - 1}))::date
      AND (${sofficeId}::uuid IS NULL OR mv.soffice_id = ${sofficeId}::uuid)
    GROUP BY mv.role_label`
  )

  return buildRoleMetricsMap(result as unknown as RoleRow[])
}

/** Builds the SALESMAN/MR metrics map from raw grouped role rows. */
export function buildRoleMetricsMap(
  rows: RoleRow[]
): Record<'SALESMAN' | 'MR', RoleVisitMetrics> {
  const map: Record<'SALESMAN' | 'MR', RoleVisitMetrics> = {
    SALESMAN: { total_visits: 0, effective_calls: 0, call_rate_pct: 0 },
    MR: { total_visits: 0, effective_calls: 0, call_rate_pct: 0 },
  }

  for (const row of rows) {
    if (row.role_label !== 'SALESMAN' && row.role_label !== 'MR') continue
    const totalVisits = toNumber(row.total_visits)
    const effectiveCalls = toNumber(row.effective_calls)
    map[row.role_label] = {
      total_visits: totalVisits,
      effective_calls: effectiveCalls,
      call_rate_pct: computeCallRate(effectiveCalls, totalVisits),
    }
  }

  return map
}
