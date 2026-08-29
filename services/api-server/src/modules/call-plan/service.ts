import { eq, and, sql, count, gte, lte, inArray, isNull } from 'drizzle-orm'

import { withRLS, db, type RLSContext, type Transaction } from '../../db'
import { visitPlans, visits } from '../../db/schema/visit'
import { appUsers } from '../../db/schema/auth'
import type {
  BulkUploadCallPlanInput,
  ListCallPlansParams,
  TodayCallPlansParams,
  CallPlanAnalyticsParams,
  CallPlanResponseType,
  CallPlanListResponseType,
  TodayCallPlansResponseType,
  BulkUploadResponseType,
  CallPlanAnalyticsResponseType,
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

/** Context required for call-plan operations (derived from JWT claims). */
interface CallPlanContext {
  companyId: string
  userId: string
  userRole: string
}

/** Formats today's date as YYYY-MM-DD. */
function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0]!
}

/** Maps a Drizzle visitPlans row to the API response shape. */
function mapPlanToResponse(row: typeof visitPlans.$inferSelect): CallPlanResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    user_id: row.userId,
    customer_id: row.customerId,
    outlet_context_id: row.outletContextId ?? null,
    plan_date: row.planDate,
    is_lead_from_erp: row.isLeadFromErp ?? false,
    is_approved: row.isApproved ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/**
 * Bulk create visit plans for Salesman & MR users.
 * Validates each plan item and skips duplicates based on unique constraint.
 */
export async function bulkCreatePlans(
  input: BulkUploadCallPlanInput,
  ctx: CallPlanContext
): Promise<BulkUploadResponseType['data']> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const errors: Array<{ index: number; message: string }> = []
    let created = 0

    // Collect unique user IDs to validate in batch
    const userIds = [...new Set(input.plans.map((p) => p.user_id))]
    const validUsers = await fetchActiveFieldUsers(tx, ctx.companyId, userIds)

    for (let i = 0; i < input.plans.length; i++) {
      const plan = input.plans[i]!
      const error = validatePlanItem(plan, validUsers, i)
      if (error) {
        errors.push(error)
        continue
      }

      const inserted = await insertPlanIfNotDuplicate(tx, ctx.companyId, plan)
      if (inserted) {
        created++
      } else {
        errors.push({ index: i, message: 'Duplicate plan: same user, customer, outlet, and date combination already exists' })
      }
    }

    return { created, errors }
  })
}

/** Fetches active Salesman/MR users within the company for validation. */
async function fetchActiveFieldUsers(
  tx: Transaction,
  companyId: string,
  userIds: string[]
): Promise<Map<string, { roleLabel: string }>> {
  if (userIds.length === 0) return new Map()

  const rows = await tx
    .select({ id: appUsers.id, roleLabel: appUsers.roleLabel })
    .from(appUsers)
    .where(
      and(
        eq(appUsers.companyId, companyId),
        inArray(appUsers.id, userIds),
        eq(appUsers.isActive, true),
        eq(appUsers.isDeleted, false)
      )
    )

  const map = new Map<string, { roleLabel: string }>()
  for (const row of rows) {
    map.set(row.id, { roleLabel: row.roleLabel })
  }
  return map
}

/** Validates a single plan item against active field user records. */
function validatePlanItem(
  plan: BulkUploadCallPlanInput['plans'][number],
  validUsers: Map<string, { roleLabel: string }>,
  index: number
): { index: number; message: string } | null {
  const user = validUsers.get(plan.user_id)
  if (!user) {
    return { index, message: `User ${plan.user_id} not found or is inactive in this company` }
  }
  if (user.roleLabel !== 'SALESMAN' && user.roleLabel !== 'MR') {
    return { index, message: `User ${plan.user_id} has role '${user.roleLabel}' — only SALESMAN and MR can have visit plans` }
  }
  return null
}

/** Attempts to insert a plan, returning false if duplicate constraint is violated. */
async function insertPlanIfNotDuplicate(
  tx: Transaction,
  companyId: string,
  plan: BulkUploadCallPlanInput['plans'][number]
): Promise<boolean> {
  try {
    await tx.insert(visitPlans).values({
      companyId,
      userId: plan.user_id,
      customerId: plan.customer_id,
      outletContextId: plan.outlet_context_id ?? null,
      planDate: plan.plan_date,
      isLeadFromErp: false,
      isApproved: true,
    })
    return true
  } catch (err: unknown) {
    if (isDuplicateError(err)) return false
    throw err
  }
}

/** Checks if a database error is a unique constraint violation. */
function isDuplicateError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === '23505'
  }
  return false
}

/** Paginated list of call plans with optional filters. */
export async function listCallPlans(
  params: ListCallPlansParams,
  ctx: CallPlanContext
): Promise<CallPlanListResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  return withRLS(rlsCtx, async (tx) => {
    const conditions = buildListConditions(params, ctx.companyId)
    const whereClause = and(...conditions)

    const [rows, totalResult] = await Promise.all([
      tx
        .select()
        .from(visitPlans)
        .where(whereClause)
        .orderBy(sql`${visitPlans.planDate} DESC`)
        .limit(limit)
        .offset(offset),
      tx
        .select({ total: count() })
        .from(visitPlans)
        .where(whereClause),
    ])

    return {
      data: rows.map(mapPlanToResponse),
      meta: { page, limit, total: totalResult[0]?.total ?? 0 },
    }
  })
}

/** Builds WHERE conditions for the list query based on provided filters. */
function buildListConditions(params: ListCallPlansParams, companyId: string) {
  const conditions = [eq(visitPlans.companyId, companyId)]

  if (params.user_id) {
    conditions.push(eq(visitPlans.userId, params.user_id))
  }
  if (params.is_approved !== undefined) {
    conditions.push(eq(visitPlans.isApproved, params.is_approved))
  }
  if (params.month && params.year) {
    const startDate = `${params.year}-${String(params.month).padStart(2, '0')}-01`
    const endDate = getLastDayOfMonth(params.year, params.month)
    conditions.push(gte(visitPlans.planDate, startDate))
    conditions.push(lte(visitPlans.planDate, endDate))
  } else if (params.year) {
    conditions.push(gte(visitPlans.planDate, `${params.year}-01-01`))
    conditions.push(lte(visitPlans.planDate, `${params.year}-12-31`))
  }

  return conditions
}

/** Returns the last day of a given month as YYYY-MM-DD. */
function getLastDayOfMonth(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
}

/** Get today's plans for the current user (or admin override). */
export async function getTodayPlans(
  params: TodayCallPlansParams,
  ctx: CallPlanContext
): Promise<TodayCallPlansResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const targetUserId = params.user_id ?? ctx.userId

  return withRLS(rlsCtx, async (tx) => {
    const today = getTodayDateString()

    const rows = await tx
      .select()
      .from(visitPlans)
      .where(
        and(
          eq(visitPlans.companyId, ctx.companyId),
          eq(visitPlans.userId, targetUserId),
          eq(visitPlans.planDate, today)
        )
      )
      .orderBy(sql`${visitPlans.createdAt} ASC`)

    return { data: rows.map(mapPlanToResponse) }
  })
}

/** Calculates call rate percentage with 2 decimal precision. Returns 0 if no plans. */
export function calculateCallRate(totalVisited: number, totalPlanned: number): number {
  if (totalPlanned <= 0) return 0
  return Math.round((totalVisited / totalPlanned) * 10000) / 100
}

/** Role-level summary entry shape. */
interface RoleSummary {
  total_planned: number
  total_visited: number
  call_rate_pct: number
}

/** Aggregates per-user data into role-segmented summaries. */
export function buildRoleSummary(
  data: Array<{ role_label: 'SALESMAN' | 'MR'; total_planned: number; total_visited: number }>
): { SALESMAN: RoleSummary; MR: RoleSummary } {
  const acc = { SALESMAN: { total_planned: 0, total_visited: 0 }, MR: { total_planned: 0, total_visited: 0 } }

  for (const entry of data) {
    acc[entry.role_label].total_planned += entry.total_planned
    acc[entry.role_label].total_visited += entry.total_visited
  }

  return {
    SALESMAN: { ...acc.SALESMAN, call_rate_pct: calculateCallRate(acc.SALESMAN.total_visited, acc.SALESMAN.total_planned) },
    MR: { ...acc.MR, call_rate_pct: calculateCallRate(acc.MR.total_visited, acc.MR.total_planned) },
  }
}

/**
 * Computes call rate analytics for a given month/year.
 * Formula: (actual completed visits / planned visits) × 100
 */
export async function getCallPlanAnalytics(
  params: CallPlanAnalyticsParams,
  ctx: CallPlanContext
): Promise<CallPlanAnalyticsResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const startDate = `${params.year}-${String(params.month).padStart(2, '0')}-01`
  const endDate = getLastDayOfMonth(params.year, params.month)

  return withRLS(rlsCtx, async (tx) => {
    const userConditions = buildAnalyticsUserConditions(params, ctx.companyId)

    const users = await tx
      .select({ id: appUsers.id, fullName: appUsers.fullName, roleLabel: appUsers.roleLabel })
      .from(appUsers)
      .where(and(...userConditions))

    if (users.length === 0) {
      const emptySummary = { SALESMAN: { total_planned: 0, total_visited: 0, call_rate_pct: 0 }, MR: { total_planned: 0, total_visited: 0, call_rate_pct: 0 } }
      return { data: [], summary: emptySummary, meta: { month: params.month, year: params.year, total_users: 0 } }
    }

    const userIds = users.map((u) => u.id)
    const [plannedCounts, visitedCounts] = await Promise.all([
      fetchPlannedCounts(tx, ctx.companyId, userIds, startDate, endDate),
      fetchVisitedCounts(tx, ctx.companyId, userIds, startDate, endDate),
    ])

    const plannedMap = new Map(plannedCounts.map((r) => [r.userId, r.total]))
    const visitedMap = new Map(visitedCounts.map((r) => [r.userId, r.total]))

    const data = users.map((user) => {
      const totalPlanned = plannedMap.get(user.id) ?? 0
      const totalVisited = visitedMap.get(user.id) ?? 0
      return {
        user_id: user.id,
        user_name: user.fullName,
        role_label: user.roleLabel as 'SALESMAN' | 'MR',
        total_planned: totalPlanned,
        total_visited: totalVisited,
        call_rate_pct: calculateCallRate(totalVisited, totalPlanned),
      }
    })

    const summary = buildRoleSummary(data)

    return { data, summary, meta: { month: params.month, year: params.year, total_users: users.length } }
  })
}

/** Counts planned visits per user within a date range. */
async function fetchPlannedCounts(
  tx: Transaction,
  companyId: string,
  userIds: string[],
  startDate: string,
  endDate: string
) {
  return tx
    .select({ userId: visitPlans.userId, total: count() })
    .from(visitPlans)
    .where(and(
      eq(visitPlans.companyId, companyId),
      inArray(visitPlans.userId, userIds),
      gte(visitPlans.planDate, startDate),
      lte(visitPlans.planDate, endDate)
    ))
    .groupBy(visitPlans.userId)
}

/** Counts completed visits (visit_out_at IS NOT NULL) per user within a date range. */
async function fetchVisitedCounts(
  tx: Transaction,
  companyId: string,
  userIds: string[],
  startDate: string,
  endDate: string
) {
  return tx
    .select({ userId: visits.userId, total: count() })
    .from(visits)
    .where(and(
      eq(visits.companyId, companyId),
      inArray(visits.userId, userIds),
      gte(visits.visitDate, startDate),
      lte(visits.visitDate, endDate),
      sql`${visits.visitOutAt} IS NOT NULL`
    ))
    .groupBy(visits.userId)
}

/** Builds WHERE conditions to filter users for analytics query. */
function buildAnalyticsUserConditions(params: CallPlanAnalyticsParams, companyId: string) {
  const conditions = [
    eq(appUsers.companyId, companyId),
    eq(appUsers.isActive, true),
    eq(appUsers.isDeleted, false),
    inArray(appUsers.roleLabel, ['SALESMAN', 'MR']),
  ]

  if (params.user_id) {
    conditions.push(eq(appUsers.id, params.user_id))
  }
  if (params.soffice_id) {
    conditions.push(eq(appUsers.sofficeId, params.soffice_id))
  }
  if (params.role_filter) {
    conditions.push(eq(appUsers.roleLabel, params.role_filter))
  }

  return conditions
}

// --- Visit Type Classification ---

/** Parameters for classifying a visit as PLANNED or EXTRA. */
export interface ClassifyVisitTypeParams {
  companyId: string
  userId: string
  customerId: string
  outletId: string | null
  visitDate: string
}

/** Valid visit type values returned by classification. */
export type VisitTypeResult = 'PLANNED' | 'EXTRA'

/**
 * Classifies a visit as PLANNED or EXTRA by checking for a matching plan record.
 *
 * Matching criteria (FR-SCP-02):
 * - Same company_id, user_id, customer_id, and plan_date = visit_date
 * - outlet_context_id matches outlet_id (both null or equal)
 *
 * Returns 'PLANNED' if a matching plan exists, 'EXTRA' otherwise.
 * Accepts a Drizzle transaction to be used within visit creation flows.
 */
export async function classifyVisitType(
  params: ClassifyVisitTypeParams,
  tx: Transaction
): Promise<VisitTypeResult> {
  const outletCondition = params.outletId
    ? eq(visitPlans.outletContextId, params.outletId)
    : isNull(visitPlans.outletContextId)

  const result = await tx
    .select({ id: visitPlans.id })
    .from(visitPlans)
    .where(
      and(
        eq(visitPlans.companyId, params.companyId),
        eq(visitPlans.userId, params.userId),
        eq(visitPlans.customerId, params.customerId),
        eq(visitPlans.planDate, params.visitDate),
        outletCondition
      )
    )
    .limit(1)

  return result.length > 0 ? 'PLANNED' : 'EXTRA'
}
