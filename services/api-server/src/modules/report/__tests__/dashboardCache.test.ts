import { describe, it, expect, mock, beforeEach } from 'bun:test'

import {
  buildDashboardKpiCacheKey,
  resolveDashboardCacheTtl,
  DASHBOARD_CACHE_TTL_MIN_SECONDS,
  DASHBOARD_CACHE_TTL_MAX_SECONDS,
  DASHBOARD_CACHE_TTL_DEFAULT_SECONDS,
} from '../dashboardCache'

// --- Mock Redis client (shared config/redis) ---
interface MockRedisState {
  store: Map<string, string>
  getError: boolean
  setError: boolean
  getCalls: number
  setCalls: string[]
}

let redisState: MockRedisState

function resetRedisState(): void {
  redisState = { store: new Map(), getError: false, setError: false, getCalls: 0, setCalls: [] }
}

resetRedisState()

mock.module('../../../config/redis', () => ({
  redis: {
    get: (key: string) => {
      redisState.getCalls += 1
      if (redisState.getError) return Promise.reject(new Error('redis down'))
      return Promise.resolve(redisState.store.get(key) ?? null)
    },
    set: (key: string, value: string) => {
      redisState.setCalls.push(key)
      if (redisState.setError) return Promise.reject(new Error('redis down'))
      redisState.store.set(key, value)
      return Promise.resolve('OK')
    },
  },
}))

// --- Mock db so the compute path is deterministic and counts invocations ---
let computeCalls = 0

function buildMockTx() {
  let call = 0
  return {
    execute: () => {
      call += 1
      return Promise.resolve(
        call === 1
          ? [{ total_active_users: 5, total_orders: 8, total_revenue: '1000' }]
          : [
              { role_label: 'SALESMAN', total_visits: '4', effective_calls: '2' },
              { role_label: 'MR', total_visits: '2', effective_calls: '1' },
            ]
      )
    },
  }
}

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    computeCalls += 1
    return cb(buildMockTx())
  },
}))

const { getDashboardKpi } = await import('../service')

const ctx = { companyId: 'company-1', userId: 'user-1', userRole: 'ADMIN_CABANG' }

describe('report/dashboardCache — key strategy', () => {
  it('should scope the key by company_id to prevent cross-tenant leakage', () => {
    const a = buildDashboardKpiCacheKey('company-a', { period: 'month' })
    const b = buildDashboardKpiCacheKey('company-b', { period: 'month' })
    expect(a).not.toBe(b)
    expect(a).toContain('company-a')
    expect(b).toContain('company-b')
  })

  it('should include soffice and period, defaulting soffice to "all"', () => {
    expect(buildDashboardKpiCacheKey('c1', { period: 'week' })).toBe('dashboard:kpi:c1:all:week')
    expect(buildDashboardKpiCacheKey('c1', { soffice_id: 's9', period: 'today' })).toBe(
      'dashboard:kpi:c1:s9:today'
    )
  })

  it('should default period to month when omitted', () => {
    expect(buildDashboardKpiCacheKey('c1', {})).toBe('dashboard:kpi:c1:all:month')
  })
})

describe('report/dashboardCache — TTL resolution', () => {
  const original = process.env['DASHBOARD_CACHE_TTL_SECONDS']

  beforeEach(() => {
    if (original === undefined) delete process.env['DASHBOARD_CACHE_TTL_SECONDS']
    else process.env['DASHBOARD_CACHE_TTL_SECONDS'] = original
  })

  it('should use the default when the env var is absent', () => {
    delete process.env['DASHBOARD_CACHE_TTL_SECONDS']
    expect(resolveDashboardCacheTtl()).toBe(DASHBOARD_CACHE_TTL_DEFAULT_SECONDS)
  })

  it('should clamp values below the 5-minute floor', () => {
    process.env['DASHBOARD_CACHE_TTL_SECONDS'] = '10'
    expect(resolveDashboardCacheTtl()).toBe(DASHBOARD_CACHE_TTL_MIN_SECONDS)
  })

  it('should clamp values above the 15-minute ceiling', () => {
    process.env['DASHBOARD_CACHE_TTL_SECONDS'] = '99999'
    expect(resolveDashboardCacheTtl()).toBe(DASHBOARD_CACHE_TTL_MAX_SECONDS)
  })

  it('should accept a valid in-range value', () => {
    process.env['DASHBOARD_CACHE_TTL_SECONDS'] = '600'
    expect(resolveDashboardCacheTtl()).toBe(600)
  })

  it('should fall back to default for non-numeric input', () => {
    process.env['DASHBOARD_CACHE_TTL_SECONDS'] = 'abc'
    expect(resolveDashboardCacheTtl()).toBe(DASHBOARD_CACHE_TTL_DEFAULT_SECONDS)
  })
})

describe('report/dashboardCache — cache-aside behavior via getDashboardKpi', () => {
  beforeEach(() => {
    resetRedisState()
    computeCalls = 0
  })

  it('should compute and populate the cache on a miss', async () => {
    const result = await getDashboardKpi({ period: 'month' }, ctx)

    expect(computeCalls).toBe(1)
    expect(redisState.setCalls).toContain('dashboard:kpi:company-1:all:month')
    expect(result.data.total_active_users).toBe(5)
  })

  it('should return the cached value without recomputing on a hit', async () => {
    await getDashboardKpi({ period: 'month' }, ctx)
    expect(computeCalls).toBe(1)

    const cachedResult = await getDashboardKpi({ period: 'month' }, ctx)
    expect(computeCalls).toBe(1) // no additional compute
    expect(cachedResult.data.total_active_users).toBe(5)
  })

  it('should not share cache entries across tenants', async () => {
    await getDashboardKpi({ period: 'month' }, { ...ctx, companyId: 'company-1' })
    await getDashboardKpi({ period: 'month' }, { ...ctx, companyId: 'company-2' })

    expect(computeCalls).toBe(2)
    expect(redisState.store.has('dashboard:kpi:company-1:all:month')).toBe(true)
    expect(redisState.store.has('dashboard:kpi:company-2:all:month')).toBe(true)
  })

  it('should fall back to fresh computation when Redis GET fails', async () => {
    redisState.getError = true
    redisState.setError = true

    const result = await getDashboardKpi({ period: 'week' }, ctx)

    expect(computeCalls).toBe(1)
    expect(result.data.total_orders).toBe(8)
  })
})
