import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { Job } from 'bullmq'

// --- Mock Redis (isolate connection + cache scan/del) ---
// createRedisConnection must return a harmless object (BullMQ Queue/Worker are
// lazy singletons never constructed in these tests). `redis.scan` returns the
// seeded keys in one page; `redis.del` records what was invalidated.
let scanKeysResult: string[] = []
const delCalls: string[][] = []

mock.module('../../config/redis', () => ({
  redis: {
    scan: (_cursor: string, ..._args: unknown[]) =>
      Promise.resolve(['0', scanKeysResult] as [string, string[]]),
    del: (...keys: string[]) => {
      delCalls.push(keys)
      return Promise.resolve(keys.length)
    },
  },
  createRedisConnection: () => ({}),
  REDIS_URL: 'redis://localhost:6379',
}))

// --- Mock DB: record each REFRESH statement, optionally fail specific views ---
const executedStatements: string[] = []
let failingViewFragment: string | null = null

// `sql.raw()` produces a query object; the fake `execute` stringifies it well
// enough to assert order + detect the targeted view. We reconstruct the SQL
// from the recorded call argument's own text where available.
const realDb = await import('../../db')
mock.module('../../db', () => ({
  ...realDb,
  db: {
    execute: (query: unknown) => {
      const text = extractSqlText(query)
      executedStatements.push(text)
      if (failingViewFragment && text.includes(failingViewFragment)) {
        return Promise.reject(new Error(`boom: ${failingViewFragment}`))
      }
      return Promise.resolve([])
    },
  },
}))

/** Best-effort extraction of raw SQL text from a drizzle sql.raw() object. */
function extractSqlText(query: unknown): string {
  if (typeof query === 'string') return query
  if (query && typeof query === 'object') {
    const q = query as { queryChunks?: unknown[]; sql?: string; value?: unknown }
    if (typeof q.sql === 'string') return q.sql
    if (Array.isArray(q.queryChunks)) {
      return q.queryChunks.map((c) => stringifyChunk(c)).join('')
    }
  }
  return String(query)
}

function stringifyChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk && typeof chunk === 'object' && 'value' in chunk) {
    const v = (chunk as { value: unknown }).value
    return Array.isArray(v) ? v.join('') : String(v)
  }
  return ''
}

const {
  MV_REFRESH_VIEWS,
  MV_REFRESH_MAX_ATTEMPTS,
  MV_REFRESH_BACKOFF_DELAY_MS,
  MV_REFRESH_JOB_OPTIONS,
  MV_REFRESH_DEFAULT_INTERVAL_MS,
  DASHBOARD_CACHE_KEY_PREFIX,
  resolveRefreshIntervalMs,
  refreshAllViews,
  invalidateDashboardCache,
  processMvRefreshJob,
} = await import('../mvRefreshWorker')

function makeJob(): Job<Record<string, never>> {
  return { id: 'mv-job-1', data: {} } as unknown as Job<Record<string, never>>
}

beforeEach(() => {
  executedStatements.length = 0
  delCalls.length = 0
  failingViewFragment = null
  scanKeysResult = []
})

describe('MV_REFRESH_VIEWS allowlist', () => {
  it('contains all five reporting views', () => {
    expect(MV_REFRESH_VIEWS).toEqual([
      'mv_daily_branch_performance',
      'mv_call_rate_analytics',
      'mv_order_revenue_daily',
      'mv_attendance_compliance',
      'mv_user_territory_performance',
    ])
  })
})

describe('refreshAllViews — ordered concurrent refresh', () => {
  it('issues one CONCURRENTLY refresh per view, in allowlist order', async () => {
    const cycle = await refreshAllViews()

    expect(executedStatements).toHaveLength(MV_REFRESH_VIEWS.length)
    executedStatements.forEach((stmt, i) => {
      expect(stmt).toContain('REFRESH MATERIALIZED VIEW CONCURRENTLY')
      expect(stmt).toContain(MV_REFRESH_VIEWS[i]!)
    })
    expect(cycle.successCount).toBe(MV_REFRESH_VIEWS.length)
    expect(cycle.failureCount).toBe(0)
  })
})

describe('refreshAllViews — single-view failure isolation', () => {
  it('continues refreshing remaining views when one view fails', async () => {
    failingViewFragment = 'mv_order_revenue_daily'

    const cycle = await refreshAllViews()

    // Every view is still attempted despite the middle failure.
    expect(executedStatements).toHaveLength(MV_REFRESH_VIEWS.length)
    expect(cycle.failureCount).toBe(1)
    expect(cycle.successCount).toBe(MV_REFRESH_VIEWS.length - 1)

    const failed = cycle.results.find((r) => !r.ok)
    expect(failed?.view).toBe('mv_order_revenue_daily')
    expect(failed?.errorMessage).toContain('boom')
  })
})

describe('invalidateDashboardCache', () => {
  it('scans + deletes matching dashboard keys and returns the count', async () => {
    scanKeysResult = [`${DASHBOARD_CACHE_KEY_PREFIX}kpi:month`, `${DASHBOARD_CACHE_KEY_PREFIX}branch`]

    const count = await invalidateDashboardCache()

    expect(count).toBe(2)
    expect(delCalls).toHaveLength(1)
    expect(delCalls[0]).toEqual(scanKeysResult)
  })

  it('is a no-op (no del call) when no keys match', async () => {
    scanKeysResult = []
    const count = await invalidateDashboardCache()
    expect(count).toBe(0)
    expect(delCalls).toHaveLength(0)
  })
})

describe('processMvRefreshJob', () => {
  it('refreshes all views then invalidates the dashboard cache', async () => {
    scanKeysResult = [`${DASHBOARD_CACHE_KEY_PREFIX}kpi`]

    const cycle = await processMvRefreshJob(makeJob())

    expect(executedStatements).toHaveLength(MV_REFRESH_VIEWS.length)
    expect(cycle.successCount).toBe(MV_REFRESH_VIEWS.length)
    // Cache invalidation happened after the refresh cycle.
    expect(delCalls).toHaveLength(1)
    expect(delCalls[0]).toEqual([`${DASHBOARD_CACHE_KEY_PREFIX}kpi`])
  })

  it('still invalidates cache even when a view refresh fails', async () => {
    failingViewFragment = 'mv_attendance_compliance'
    scanKeysResult = [`${DASHBOARD_CACHE_KEY_PREFIX}kpi`]

    const cycle = await processMvRefreshJob(makeJob())

    expect(cycle.failureCount).toBe(1)
    expect(delCalls).toHaveLength(1)
  })
})

describe('resolveRefreshIntervalMs', () => {
  it('prefers an explicit positive interval', () => {
    expect(resolveRefreshIntervalMs(60_000)).toBe(60_000)
  })

  it('falls back to the 10-minute default for missing/invalid input', () => {
    const prev = process.env['MV_REFRESH_INTERVAL_MS']
    delete process.env['MV_REFRESH_INTERVAL_MS']
    expect(resolveRefreshIntervalMs()).toBe(MV_REFRESH_DEFAULT_INTERVAL_MS)
    expect(resolveRefreshIntervalMs(-5)).toBe(MV_REFRESH_DEFAULT_INTERVAL_MS)
    if (prev !== undefined) process.env['MV_REFRESH_INTERVAL_MS'] = prev
  })

  it('reads MV_REFRESH_INTERVAL_MS from the environment', () => {
    const prev = process.env['MV_REFRESH_INTERVAL_MS']
    process.env['MV_REFRESH_INTERVAL_MS'] = '300000'
    expect(resolveRefreshIntervalMs()).toBe(300_000)
    if (prev !== undefined) process.env['MV_REFRESH_INTERVAL_MS'] = prev
    else delete process.env['MV_REFRESH_INTERVAL_MS']
  })
})

describe('MV_REFRESH_JOB_OPTIONS — retry/backoff configuration', () => {
  it('bounds attempts to MV_REFRESH_MAX_ATTEMPTS', () => {
    expect(MV_REFRESH_MAX_ATTEMPTS).toBe(3)
    expect(MV_REFRESH_JOB_OPTIONS.attempts).toBe(MV_REFRESH_MAX_ATTEMPTS)
  })

  it('uses an exponential backoff strategy with the configured base delay', () => {
    expect(MV_REFRESH_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: MV_REFRESH_BACKOFF_DELAY_MS,
    })
  })
})
