import { describe, it, expect } from 'bun:test'

import { buildCallRateRows, resolveMonthRange } from '../callRate'
import { buildCallRateCacheKey } from '../dashboardCache'

type FieldUser = Parameters<typeof buildCallRateRows>[0][number]

const users: FieldUser[] = [
  { id: 'u-1', fullName: 'Alice', roleLabel: 'SALESMAN', sofficeId: 's-a' },
  { id: 'u-2', fullName: 'Bob', roleLabel: 'MR', sofficeId: 's-a' },
]

describe('report/callRate — buildCallRateRows', () => {
  it('should join planned and visited counts per user', () => {
    const rows = buildCallRateRows(
      users,
      [{ userId: 'u-1', total: 10 }, { userId: 'u-2', total: 5 }],
      [{ userId: 'u-1', total: 8 }, { userId: 'u-2', total: 1 }]
    )

    const alice = rows.find((r) => r.user_id === 'u-1')!
    expect(alice.total_planned).toBe(10)
    expect(alice.total_visited).toBe(8)
    expect(alice.call_rate_pct).toBe(80)
  })

  it('should default missing counts to zero and call_rate_pct to 0', () => {
    const rows = buildCallRateRows(users, [], [])
    expect(rows.every((r) => r.total_planned === 0 && r.total_visited === 0)).toBe(true)
    expect(rows.every((r) => r.call_rate_pct === 0)).toBe(true)
  })

  it('should coerce a null soffice_id to an empty string', () => {
    const rows = buildCallRateRows(
      [{ id: 'u-x', fullName: 'X', roleLabel: 'MR', sofficeId: null }],
      [],
      []
    )
    expect(rows[0]!.soffice_id).toBe('')
  })

  it('should sort by call rate descending, then user name', () => {
    const rows = buildCallRateRows(
      users,
      [{ userId: 'u-1', total: 10 }, { userId: 'u-2', total: 10 }],
      [{ userId: 'u-1', total: 5 }, { userId: 'u-2', total: 9 }]
    )
    // Bob 90% ranks above Alice 50%
    expect(rows.map((r) => r.user_id)).toEqual(['u-2', 'u-1'])
  })
})

describe('report/callRate — resolveMonthRange', () => {
  it('should compute inclusive first/last day for a 31-day month', () => {
    expect(resolveMonthRange({ month: 1, year: 2025 })).toEqual({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
    })
  })

  it('should handle February in a non-leap year', () => {
    expect(resolveMonthRange({ month: 2, year: 2025 })).toEqual({
      startDate: '2025-02-01',
      endDate: '2025-02-28',
    })
  })

  it('should handle February in a leap year', () => {
    expect(resolveMonthRange({ month: 2, year: 2024 }).endDate).toBe('2024-02-29')
  })
})

describe('report/callRate — buildCallRateCacheKey', () => {
  it('should scope the key by company_id to prevent cross-tenant leakage', () => {
    const a = buildCallRateCacheKey('company-a', { month: 6, year: 2025 })
    const b = buildCallRateCacheKey('company-b', { month: 6, year: 2025 })
    expect(a).not.toBe(b)
    expect(a).toContain('company-a')
  })

  it('should default optional filters to "all"', () => {
    expect(buildCallRateCacheKey('c1', { month: 6, year: 2025 })).toBe(
      'report:call-rate:c1:2025:6:all:all:all'
    )
  })

  it('should include user, soffice and role filters when present', () => {
    expect(
      buildCallRateCacheKey('c1', {
        month: 6,
        year: 2025,
        user_id: 'u-1',
        soffice_id: 's-1',
        role: 'MR',
      })
    ).toBe('report:call-rate:c1:2025:6:u-1:s-1:MR')
  })
})
