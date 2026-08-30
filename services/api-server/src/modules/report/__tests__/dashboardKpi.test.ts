import { describe, it, expect } from 'bun:test'

import {
  toNumber,
  resolvePeriodDays,
  computeCallRate,
  buildRoleMetricsMap,
} from '../dashboardKpi'

describe('report/dashboardKpi — toNumber', () => {
  it('should coerce a numeric string to a number', () => {
    expect(toNumber('42.5')).toBe(42.5)
  })

  it('should pass through an existing number', () => {
    expect(toNumber(7)).toBe(7)
  })

  it('should return 0 for null, undefined, and non-numeric strings', () => {
    expect(toNumber(null)).toBe(0)
    expect(toNumber(undefined)).toBe(0)
    expect(toNumber('not-a-number')).toBe(0)
  })
})

describe('report/dashboardKpi — resolvePeriodDays', () => {
  it('should map supported periods to their day windows', () => {
    expect(resolvePeriodDays('today')).toBe(1)
    expect(resolvePeriodDays('week')).toBe(7)
    expect(resolvePeriodDays('month')).toBe(30)
  })

  it('should default to a 30-day window when period is undefined or unknown', () => {
    expect(resolvePeriodDays(undefined)).toBe(30)
    expect(resolvePeriodDays('quarter')).toBe(30)
  })
})

describe('report/dashboardKpi — computeCallRate', () => {
  it('should compute (effective / total) * 100 rounded to 2 decimals', () => {
    expect(computeCallRate(3, 4)).toBe(75)
    expect(computeCallRate(1, 3)).toBe(33.33)
  })

  it('should return 0 when total visits is zero to avoid division by zero', () => {
    expect(computeCallRate(5, 0)).toBe(0)
    expect(computeCallRate(0, 0)).toBe(0)
  })
})

describe('report/dashboardKpi — buildRoleMetricsMap', () => {
  it('should aggregate SALESMAN and MR rows into a segmented map', () => {
    const map = buildRoleMetricsMap([
      { role_label: 'SALESMAN', total_visits: '10', effective_calls: '4' },
      { role_label: 'MR', total_visits: 8, effective_calls: 2 },
    ])

    expect(map.SALESMAN).toEqual({ total_visits: 10, effective_calls: 4, call_rate_pct: 40 })
    expect(map.MR).toEqual({ total_visits: 8, effective_calls: 2, call_rate_pct: 25 })
  })

  it('should default missing roles to zeroed metrics', () => {
    const map = buildRoleMetricsMap([
      { role_label: 'SALESMAN', total_visits: 5, effective_calls: 5 },
    ])

    expect(map.SALESMAN.call_rate_pct).toBe(100)
    expect(map.MR).toEqual({ total_visits: 0, effective_calls: 0, call_rate_pct: 0 })
  })

  it('should ignore rows with unexpected role labels', () => {
    const map = buildRoleMetricsMap([
      { role_label: 'ADMIN_PUSAT', total_visits: 99, effective_calls: 99 },
    ])

    expect(map.SALESMAN.total_visits).toBe(0)
    expect(map.MR.total_visits).toBe(0)
  })
})
