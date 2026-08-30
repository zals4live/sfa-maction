import { sql } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { toNumber, computeCallRate } from './dashboardKpi'

/**
 * Branch performance matrix aggregation from the reporting materialized views.
 *
 * Ranking strategy (FR-REP-02):
 *   Branches (soffices) are ranked by revenue, visits, and strike rate. The
 *   branch-level headline totals (visits, revenue) are sourced from
 *   `mv_daily_branch_performance`, restricted to the requested calendar month.
 *   That view aggregates across ALL field users per branch/day and carries no
 *   `role_label`, so it cannot produce the Salesman-vs-MR breakdown by itself.
 *
 *   The per-role (SALESMAN / MR) segmentation is derived from the role-carrying
 *   view `mv_user_territory_performance`, which stores `role_label`,
 *   `total_visits`, `completed_visits`, and `total_orders` per user per month.
 *   Both views are queried inside the same RLS-scoped transaction so tenant
 *   isolation is enforced by the `mv_*` company_id filter plus the session
 *   `app.current_company_id`. All values are parameterized.
 */

/** Per-role visit block reused across KPI and performance reports. */
export interface RoleMetrics {
  total_visits: number
  effective_calls: number
  call_rate_pct: number
}

/** A single ranked branch row with role-segmented metrics. */
export interface BranchPerformanceRow {
  soffice_id: string
  soffice_name: string
  rank: number
  total_visits: number
  total_revenue: number
  strike_rate_pct: number
  SALESMAN: RoleMetrics
  MR: RoleMetrics
}

/** Raw branch headline row from mv_daily_branch_performance. */
interface BranchTotalsRow {
  soffice_id: string
  soffice_name: string | null
  total_visits: number | string | null
  total_revenue: number | string | null
  orders_from_visits: number | string | null
}

/** Raw per-branch-per-role row from mv_user_territory_performance. */
interface BranchRoleRow {
  soffice_id: string
  role_label: string
  total_visits: number | string | null
  effective_calls: number | string | null
}

/** Zeroed role metrics used as the default for branches missing a role. */
function emptyRoleMetrics(): RoleMetrics {
  return { total_visits: 0, effective_calls: 0, call_rate_pct: 0 }
}

/**
 * Computes a strike rate percentage: (orders / visits) × 100, rounded to two
 * decimals. Returns 0 when there are no visits to avoid division by zero.
 */
export function computeStrikeRate(orders: number, totalVisits: number): number {
  if (totalVisits <= 0) return 0
  return Math.round((orders / totalVisits) * 10000) / 100
}

/**
 * Fetches per-branch headline totals (visits, revenue, orders-from-visits) from
 * mv_daily_branch_performance for the requested calendar month.
 */
export async function fetchBranchTotals(
  tx: Transaction,
  companyId: string,
  month: number,
  year: number
): Promise<BranchTotalsRow[]> {
  const result = await tx.execute(
    sql`SELECT
      mv.soffice_id,
      MAX(mv.soffice_name) AS soffice_name,
      COALESCE(SUM(mv.total_visits), 0) AS total_visits,
      COALESCE(SUM(mv.total_revenue), 0) AS total_revenue,
      COALESCE(SUM(ROUND(mv.total_visits * mv.effective_call_rate_pct / 100.0)), 0) AS orders_from_visits
    FROM mv_daily_branch_performance mv
    WHERE mv.company_id = ${companyId}
      AND EXTRACT(MONTH FROM mv.report_date) = ${month}
      AND EXTRACT(YEAR FROM mv.report_date) = ${year}
    GROUP BY mv.soffice_id`
  )
  return result as unknown as BranchTotalsRow[]
}

/**
 * Fetches per-branch-per-role visit metrics from mv_user_territory_performance
 * for the requested calendar month, grouped by branch and role.
 */
export async function fetchBranchRoleMetrics(
  tx: Transaction,
  companyId: string,
  month: number,
  year: number
): Promise<BranchRoleRow[]> {
  const result = await tx.execute(
    sql`SELECT
      mv.soffice_id,
      mv.role_label,
      COALESCE(SUM(mv.total_visits), 0) AS total_visits,
      COALESCE(SUM(mv.total_orders), 0) AS effective_calls
    FROM mv_user_territory_performance mv
    WHERE mv.company_id = ${companyId}
      AND mv.role_label IN ('SALESMAN', 'MR')
      AND EXTRACT(MONTH FROM mv.performance_month) = ${month}
      AND EXTRACT(YEAR FROM mv.performance_month) = ${year}
    GROUP BY mv.soffice_id, mv.role_label`
  )
  return result as unknown as BranchRoleRow[]
}

/** Indexes per-role rows by soffice_id → { SALESMAN, MR } metrics. */
function indexRoleMetricsBySoffice(
  rows: BranchRoleRow[]
): Map<string, { SALESMAN: RoleMetrics; MR: RoleMetrics }> {
  const map = new Map<string, { SALESMAN: RoleMetrics; MR: RoleMetrics }>()

  for (const row of rows) {
    if (row.role_label !== 'SALESMAN' && row.role_label !== 'MR') continue
    const entry = map.get(row.soffice_id) ?? {
      SALESMAN: emptyRoleMetrics(),
      MR: emptyRoleMetrics(),
    }
    const totalVisits = toNumber(row.total_visits)
    const effectiveCalls = toNumber(row.effective_calls)
    entry[row.role_label] = {
      total_visits: totalVisits,
      effective_calls: effectiveCalls,
      call_rate_pct: computeCallRate(effectiveCalls, totalVisits),
    }
    map.set(row.soffice_id, entry)
  }

  return map
}

/**
 * Ranks branches by revenue, then visits, then strike rate (all descending).
 * Ties are broken deterministically by soffice_id to keep output stable.
 */
function compareBranches(a: BranchPerformanceRow, b: BranchPerformanceRow): number {
  if (b.total_revenue !== a.total_revenue) return b.total_revenue - a.total_revenue
  if (b.total_visits !== a.total_visits) return b.total_visits - a.total_visits
  if (b.strike_rate_pct !== a.strike_rate_pct) return b.strike_rate_pct - a.strike_rate_pct
  return a.soffice_id.localeCompare(b.soffice_id)
}

/**
 * Assembles the ranked branch performance matrix from raw branch totals and
 * per-role metrics. Sorting and rank assignment happen here so the query
 * helpers stay focused on data retrieval.
 */
export function buildBranchPerformanceMatrix(
  totals: BranchTotalsRow[],
  roleRows: BranchRoleRow[]
): BranchPerformanceRow[] {
  const roleBySoffice = indexRoleMetricsBySoffice(roleRows)

  const rows: BranchPerformanceRow[] = totals.map((t) => {
    const visits = toNumber(t.total_visits)
    const roles = roleBySoffice.get(t.soffice_id)
    return {
      soffice_id: t.soffice_id,
      soffice_name: t.soffice_name ?? '',
      rank: 0,
      total_visits: visits,
      total_revenue: toNumber(t.total_revenue),
      strike_rate_pct: computeStrikeRate(toNumber(t.orders_from_visits), visits),
      SALESMAN: roles?.SALESMAN ?? emptyRoleMetrics(),
      MR: roles?.MR ?? emptyRoleMetrics(),
    }
  })

  rows.sort(compareBranches)
  rows.forEach((row, index) => {
    row.rank = index + 1
  })
  return rows
}
