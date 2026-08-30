import { eq, and, sql, count, gte, lte, inArray, type SQL } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { appUsers } from '../../db/schema/auth'
import { visitPlans, visits } from '../../db/schema/visit'
import { calculateCallRate } from '../call-plan/service'
import type { CallRateParams, CallRateReportResponseType } from './schemas'

/** Field-force roles the call-rate report is restricted to. */
const FIELD_ROLES = ['SALESMAN', 'MR'] as const

/** A single call-rate row per user (matches CallRateRowSchema). */
type CallRateRow = CallRateReportResponseType['data'][number]

/** Minimal user projection needed to build a call-rate row. */
interface FieldUser {
  id: string
  fullName: string
  roleLabel: 'SALESMAN' | 'MR'
  sofficeId: string | null
}

/** Returns the last day of a given month as YYYY-MM-DD. */
function getLastDayOfMonth(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
}

/** Returns the first day of a given month as YYYY-MM-DD. */
function getFirstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/**
 * Builds WHERE conditions selecting the field users in scope for the report.
 *
 * Always restricted to active, non-deleted SALESMAN/MR users within the tenant.
 * Optional filters narrow the scope to a single user, a branch (soffice), or a
 * specific role. Absence of user_id/soffice_id yields tenant-level aggregation.
 */
export function buildCallRateUserConditions(params: CallRateParams, companyId: string): SQL[] {
  const conditions: SQL[] = [
    eq(appUsers.companyId, companyId),
    eq(appUsers.isActive, true),
    eq(appUsers.isDeleted, false),
    inArray(appUsers.roleLabel, [...FIELD_ROLES]),
  ]

  if (params.user_id) conditions.push(eq(appUsers.id, params.user_id))
  if (params.soffice_id) conditions.push(eq(appUsers.sofficeId, params.soffice_id))
  if (params.role) conditions.push(eq(appUsers.roleLabel, params.role))

  return conditions
}

/** Fetches the in-scope field users for the report. */
export async function fetchCallRateUsers(
  tx: Transaction,
  params: CallRateParams,
  companyId: string
): Promise<FieldUser[]> {
  const rows = await tx
    .select({
      id: appUsers.id,
      fullName: appUsers.fullName,
      roleLabel: appUsers.roleLabel,
      sofficeId: appUsers.sofficeId,
    })
    .from(appUsers)
    .where(and(...buildCallRateUserConditions(params, companyId)))

  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    roleLabel: r.roleLabel as 'SALESMAN' | 'MR',
    sofficeId: r.sofficeId,
  }))
}

/** Counts planned visits per user within a month date range. */
export async function fetchPlannedCounts(
  tx: Transaction,
  companyId: string,
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<Array<{ userId: string; total: number }>> {
  return tx
    .select({ userId: visitPlans.userId, total: count() })
    .from(visitPlans)
    .where(
      and(
        eq(visitPlans.companyId, companyId),
        inArray(visitPlans.userId, userIds),
        gte(visitPlans.planDate, startDate),
        lte(visitPlans.planDate, endDate)
      )
    )
    .groupBy(visitPlans.userId)
}

/** Counts completed visits (visit_out_at IS NOT NULL) per user within a month. */
export async function fetchVisitedCounts(
  tx: Transaction,
  companyId: string,
  userIds: string[],
  startDate: string,
  endDate: string
): Promise<Array<{ userId: string; total: number }>> {
  return tx
    .select({ userId: visits.userId, total: count() })
    .from(visits)
    .where(
      and(
        eq(visits.companyId, companyId),
        inArray(visits.userId, userIds),
        gte(visits.visitDate, startDate),
        lte(visits.visitDate, endDate),
        sql`${visits.visitOutAt} IS NOT NULL`
      )
    )
    .groupBy(visits.userId)
}

/**
 * Assembles per-user call-rate rows from the in-scope users and their planned /
 * visited counts. Users with no plans yield call_rate_pct = 0 (via
 * calculateCallRate). Rows are ordered by call rate descending, then name.
 */
export function buildCallRateRows(
  users: FieldUser[],
  plannedCounts: Array<{ userId: string; total: number }>,
  visitedCounts: Array<{ userId: string; total: number }>
): CallRateRow[] {
  const plannedMap = new Map(plannedCounts.map((r) => [r.userId, r.total]))
  const visitedMap = new Map(visitedCounts.map((r) => [r.userId, r.total]))

  const rows = users.map((user) => {
    const totalPlanned = plannedMap.get(user.id) ?? 0
    const totalVisited = visitedMap.get(user.id) ?? 0
    return {
      user_id: user.id,
      user_name: user.fullName,
      role_label: user.roleLabel,
      soffice_id: user.sofficeId ?? '',
      total_planned: totalPlanned,
      total_visited: totalVisited,
      call_rate_pct: calculateCallRate(totalVisited, totalPlanned),
    }
  })

  rows.sort(compareCallRateRows)
  return rows
}

/** Orders rows by call rate (desc), then user name, then id for stability. */
function compareCallRateRows(a: CallRateRow, b: CallRateRow): number {
  if (b.call_rate_pct !== a.call_rate_pct) return b.call_rate_pct - a.call_rate_pct
  const byName = a.user_name.localeCompare(b.user_name)
  if (byName !== 0) return byName
  return a.user_id.localeCompare(b.user_id)
}

/** Resolves the inclusive [start, end] date range for the report month. */
export function resolveMonthRange(params: CallRateParams): { startDate: string; endDate: string } {
  return {
    startDate: getFirstDayOfMonth(params.year, params.month),
    endDate: getLastDayOfMonth(params.year, params.month),
  }
}
