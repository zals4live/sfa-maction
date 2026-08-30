import type { DashboardKpiParams, BranchPerformanceParams, CallRateParams } from './schemas'

/** Lower bound (5 min) for the dashboard cache TTL, per tech steering. */
export const DASHBOARD_CACHE_TTL_MIN_SECONDS = 300
/** Upper bound (15 min) for the dashboard cache TTL, per tech steering. */
export const DASHBOARD_CACHE_TTL_MAX_SECONDS = 900
/** Default TTL applied when the env var is absent or invalid. */
export const DASHBOARD_CACHE_TTL_DEFAULT_SECONDS = 300

/**
 * Resolves the dashboard cache TTL from `DASHBOARD_CACHE_TTL_SECONDS`,
 * clamped to the 300–900s (5–15 min) range. Falls back to the default when
 * the value is missing or not a finite positive number.
 */
export function resolveDashboardCacheTtl(): number {
  const raw = process.env['DASHBOARD_CACHE_TTL_SECONDS']
  const parsed = raw !== undefined ? Number(raw) : Number.NaN
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : DASHBOARD_CACHE_TTL_DEFAULT_SECONDS
  return Math.min(
    DASHBOARD_CACHE_TTL_MAX_SECONDS,
    Math.max(DASHBOARD_CACHE_TTL_MIN_SECONDS, Math.floor(candidate))
  )
}

/**
 * Builds a tenant- and parameter-scoped cache key for the dashboard KPI.
 *
 * The dashboard KPI is branch/tenant scoped (not per-user), so the key is
 * scoped by `company_id`, `soffice_id` (or `all`), and `period`. Including
 * `company_id` is a hard requirement to prevent cross-tenant leakage.
 */
export function buildDashboardKpiCacheKey(companyId: string, params: DashboardKpiParams): string {
  const soffice = params.soffice_id ?? 'all'
  const period = params.period ?? 'month'
  return `dashboard:kpi:${companyId}:${soffice}:${period}`
}

/**
 * Builds a tenant- and period-scoped cache key for the branch performance
 * matrix. The matrix ranks all branches within a tenant for a given calendar
 * month, so the key is scoped by `company_id`, `year`, and `month`. Including
 * `company_id` is a hard requirement to prevent cross-tenant leakage.
 */
export function buildBranchPerformanceCacheKey(
  companyId: string,
  params: BranchPerformanceParams
): string {
  return `report:branch-performance:${companyId}:${params.year}:${params.month}`
}

/**
 * Builds a tenant- and parameter-scoped cache key for the call-rate report.
 *
 * The report aggregates call rate per user for a calendar month with optional
 * user / branch / role scoping, so the key includes `company_id`, `year`,
 * `month`, `user_id` (or `all`), `soffice_id` (or `all`), and `role` (or
 * `all`). Including `company_id` is a hard requirement to prevent cross-tenant
 * leakage.
 */
export function buildCallRateCacheKey(companyId: string, params: CallRateParams): string {
  const user = params.user_id ?? 'all'
  const soffice = params.soffice_id ?? 'all'
  const role = params.role ?? 'all'
  return `report:call-rate:${companyId}:${params.year}:${params.month}:${user}:${soffice}:${role}`
}
