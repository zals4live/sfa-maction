import { Queue, Worker } from 'bullmq'
import type { Job, JobsOptions } from 'bullmq'
import { sql } from 'drizzle-orm'

import { createRedisConnection, redis } from '../config/redis'
import { db } from '../db'

// =============================================================================
// Periodic materialized view refresh worker.
//
// Consumes the `mv-refresh` queue on a repeatable schedule and refreshes the
// reporting materialized views defined in
// infra/postgres/init-scripts/03_reporting_views.sql. Each view carries a
// UNIQUE index, so we refresh with `REFRESH MATERIALIZED VIEW CONCURRENTLY` to
// avoid blocking dashboard read queries.
//
// IMPORTANT: `REFRESH MATERIALIZED VIEW CONCURRENTLY` cannot run inside a
// transaction block. This worker therefore executes each statement directly on
// the shared `db` instance (NOT through withRLS / a transaction). The views
// already embed `company_id` in their rows and the dashboard queries scope by
// tenant at read time, so no per-tenant RLS context is set for the refresh —
// this is a deliberate system-level maintenance operation.
//
// Views are refreshed sequentially against a fixed allowlist. A single view
// failure is logged and does NOT abort the remaining refreshes. After a cycle,
// related dashboard Redis cache keys are invalidated (best-effort).
// =============================================================================

/** BullMQ queue name for periodic materialized view refresh jobs. */
export const MV_REFRESH_QUEUE = 'mv-refresh'

/** Stable job name for the repeatable refresh job. */
export const MV_REFRESH_JOB_NAME = 'refresh-reporting-views'

/**
 * Stable BullMQ job scheduler id. `upsertJobScheduler` keys the repeatable
 * schedule by this id, so re-registering on every boot is idempotent (upsert,
 * never a duplicate schedule).
 */
export const MV_REFRESH_SCHEDULER_ID = 'mv-refresh-scheduler'

/** Default refresh interval: 10 minutes (within the SQL header's 5–15 min guidance). */
export const MV_REFRESH_DEFAULT_INTERVAL_MS = 10 * 60 * 1000

/** Retry attempts for a transient refresh-cycle failure. */
export const MV_REFRESH_MAX_ATTEMPTS = 3

/** Base delay (ms) for the exponential backoff schedule. */
export const MV_REFRESH_BACKOFF_DELAY_MS = 10_000

/**
 * Dashboard Redis cache key prefix. The report module does not yet persist
 * cached responses (see modules/report/service.ts), so this establishes the
 * convention: all dashboard/report cache entries MUST be namespaced under
 * `dashboard:` so a single scan+delete can invalidate them after a refresh.
 */
export const DASHBOARD_CACHE_KEY_PREFIX = 'dashboard:'

/**
 * Ordered allowlist of materialized views to refresh. Hardcoded — never derived
 * from external input — so `sql.raw()` on these names is safe from injection.
 */
export const MV_REFRESH_VIEWS: readonly string[] = [
  'mv_daily_branch_performance',
  'mv_call_rate_analytics',
  'mv_order_revenue_daily',
  'mv_attendance_compliance',
  'mv_user_territory_performance',
] as const

/** Default per-job options: bounded attempts + exponential backoff. */
export const MV_REFRESH_JOB_OPTIONS: JobsOptions = {
  attempts: MV_REFRESH_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: MV_REFRESH_BACKOFF_DELAY_MS },
  removeOnComplete: 100,
  removeOnFail: 500,
}

/** Empty payload — the job always refreshes the full allowlist. */
export type MvRefreshJobData = Record<string, never>

/** Per-view refresh outcome captured during a cycle. */
export interface ViewRefreshResult {
  view: string
  ok: boolean
  durationMs: number
  errorMessage: string | null
}

/** Aggregate outcome of a full refresh cycle. */
export interface RefreshCycleResult {
  results: ViewRefreshResult[]
  totalDurationMs: number
  successCount: number
  failureCount: number
}

// -----------------------------------------------------------------------------
// Interval resolution
// -----------------------------------------------------------------------------

/**
 * Resolves the refresh interval (ms): the explicit argument, else the
 * `MV_REFRESH_INTERVAL_MS` env var, else the 10-minute default. Non-positive or
 * unparseable values fall back to the default.
 */
export function resolveRefreshIntervalMs(explicitMs?: number): number {
  if (typeof explicitMs === 'number' && explicitMs > 0) return explicitMs
  const raw = process.env['MV_REFRESH_INTERVAL_MS']
  const parsed = raw !== undefined ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MV_REFRESH_DEFAULT_INTERVAL_MS
}

// -----------------------------------------------------------------------------
// Queue + scheduling surface
// -----------------------------------------------------------------------------

let queueSingleton: Queue<MvRefreshJobData> | null = null

/** Lazily constructs the shared MV refresh Queue on an isolated connection. */
export function getMvRefreshQueue(): Queue<MvRefreshJobData> {
  if (!queueSingleton) {
    queueSingleton = new Queue<MvRefreshJobData>(MV_REFRESH_QUEUE, {
      connection: createRedisConnection(),
      defaultJobOptions: MV_REFRESH_JOB_OPTIONS,
    })
  }
  return queueSingleton
}

/**
 * Registers the repeatable materialized view refresh schedule via BullMQ's
 * `upsertJobScheduler`. Keyed by {@link MV_REFRESH_SCHEDULER_ID}, so calling
 * this more than once (e.g. on every boot) upserts the same schedule rather
 * than creating duplicates. Returns the resolved interval in ms.
 */
export async function scheduleMvRefresh(intervalMs?: number): Promise<number> {
  const every = resolveRefreshIntervalMs(intervalMs)
  await getMvRefreshQueue().upsertJobScheduler(
    MV_REFRESH_SCHEDULER_ID,
    { every },
    { name: MV_REFRESH_JOB_NAME, data: {} }
  )
  return every
}

// -----------------------------------------------------------------------------
// Refresh execution
// -----------------------------------------------------------------------------

/**
 * Refreshes a single materialized view CONCURRENTLY. The view name comes from
 * the hardcoded {@link MV_REFRESH_VIEWS} allowlist only — `sql.raw()` is safe
 * here because no external input ever reaches it. Runs on the top-level `db`
 * instance (NOT a transaction): CONCURRENTLY is illegal inside a tx block.
 */
export async function refreshMaterializedView(view: string): Promise<ViewRefreshResult> {
  const startedAt = performance.now()
  try {
    await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`))
    return { view, ok: true, durationMs: elapsedMs(startedAt), errorMessage: null }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown refresh failure'
    console.error(`[mvRefresh] failed to refresh ${view}: ${errorMessage}`)
    return { view, ok: false, durationMs: elapsedMs(startedAt), errorMessage }
  }
}

/** Whole-milliseconds elapsed since a `performance.now()` mark. */
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

/**
 * Refreshes every allowlisted view sequentially. A single failure is captured
 * and logged but does NOT abort the remaining refreshes, so one broken view
 * never blocks the rest of the dashboard from updating.
 */
export async function refreshAllViews(): Promise<RefreshCycleResult> {
  const cycleStartedAt = performance.now()
  const results: ViewRefreshResult[] = []
  for (const view of MV_REFRESH_VIEWS) {
    results.push(await refreshMaterializedView(view))
  }
  const failureCount = results.filter((r) => !r.ok).length
  return {
    results,
    totalDurationMs: elapsedMs(cycleStartedAt),
    successCount: results.length - failureCount,
    failureCount,
  }
}

// -----------------------------------------------------------------------------
// Dashboard cache invalidation (best-effort)
// -----------------------------------------------------------------------------

/**
 * Deletes all dashboard cache entries under {@link DASHBOARD_CACHE_KEY_PREFIX}.
 * Uses a non-blocking SCAN (never `KEYS`) to enumerate matching keys. Best
 * effort: any failure is logged and swallowed so it can never crash the worker
 * or fail an otherwise-successful refresh cycle. Returns the number deleted.
 */
export async function invalidateDashboardCache(): Promise<number> {
  try {
    const keys = await scanKeys(`${DASHBOARD_CACHE_KEY_PREFIX}*`)
    if (keys.length === 0) return 0
    await redis.del(...keys)
    return keys.length
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown cache invalidation failure'
    console.error(`[mvRefresh] dashboard cache invalidation failed: ${message}`)
    return 0
  }
}

/** Collects all keys matching a glob pattern via cursor-based SCAN. */
async function scanKeys(pattern: string): Promise<string[]> {
  const found: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    found.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return found
}

// -----------------------------------------------------------------------------
// Job processor
// -----------------------------------------------------------------------------

/**
 * Processes one refresh job: refreshes all allowlisted views, then invalidates
 * the dashboard cache. Cache invalidation runs after the refresh regardless of
 * per-view failures (partial refreshes still change data worth re-caching) and
 * is best-effort. Logs total duration + per-view failures for observability.
 */
export async function processMvRefreshJob(job: Job<MvRefreshJobData>): Promise<RefreshCycleResult> {
  const cycle = await refreshAllViews()
  const invalidated = await invalidateDashboardCache()
  console.info(
    `[mvRefresh] job ${job.id ?? MV_REFRESH_JOB_NAME} refreshed ` +
      `${cycle.successCount}/${cycle.results.length} views in ${cycle.totalDurationMs}ms ` +
      `(${cycle.failureCount} failed, ${invalidated} cache keys cleared)`
  )
  return cycle
}

// -----------------------------------------------------------------------------
// Worker bootstrap
// -----------------------------------------------------------------------------

let workerSingleton: Worker<MvRefreshJobData> | null = null

/**
 * Creates (once) and returns the BullMQ Worker consuming the MV refresh queue.
 * Uses an isolated Redis connection per BullMQ's requirement.
 *
 * CAVEAT: BullMQ requires `maxRetriesPerRequest: null` on its blocking
 * connection. `createRedisConnection()` sets that to null outside production; in
 * production it is `3`. Revisit the production Redis options if BullMQ emits a
 * connection warning (mirrors the note in erpSyncWorker.ts).
 */
export function createMvRefreshWorker(): Worker<MvRefreshJobData> {
  if (!workerSingleton) {
    workerSingleton = new Worker<MvRefreshJobData>(MV_REFRESH_QUEUE, processMvRefreshJob, {
      connection: createRedisConnection(),
    })
  }
  return workerSingleton
}
