import { describe, it, expect } from 'bun:test'

import {
  buildFraudConditions,
  resolvePagination,
  mapFraudRow,
  type FraudTelemetryRecord,
} from '../fraudIncidents'

const baseRecord: FraudTelemetryRecord = {
  id: 'f-1',
  userId: 'u-1',
  fraudType: 'VELOCITY_ANOMALY',
  severity: 'HIGH',
  claimedLat: -6.2,
  claimedLng: 106.8,
  calculatedSpeedKmh: 240.5,
  actionTaken: 'BLOCK',
  createdAt: '2025-06-15T08:30:00.000Z',
}

describe('report/fraudIncidents — buildFraudConditions', () => {
  it('should always scope to the tenant company', () => {
    const conditions = buildFraudConditions({}, 'company-1')
    expect(conditions).toHaveLength(1)
  })

  it('should add one condition per supplied optional filter', () => {
    const conditions = buildFraudConditions(
      {
        user_id: 'u-1',
        fraud_type: 'MOCK_LOCATION',
        date_from: '2025-06-01',
        date_to: '2025-06-30',
      },
      'company-1'
    )
    // company + user + fraud_type + date_from + date_to
    expect(conditions).toHaveLength(5)
  })

  it('should omit conditions for absent filters', () => {
    const conditions = buildFraudConditions({ user_id: 'u-1' }, 'company-1')
    expect(conditions).toHaveLength(2)
  })
})

describe('report/fraudIncidents — resolvePagination', () => {
  it('should default page to 1 and limit to 20', () => {
    expect(resolvePagination({})).toEqual({ page: 1, limit: 20, offset: 0 })
  })

  it('should compute offset from page and limit', () => {
    expect(resolvePagination({ page: 3, limit: 10 })).toEqual({
      page: 3,
      limit: 10,
      offset: 20,
    })
  })

  it('should yield a zero offset on the first page', () => {
    expect(resolvePagination({ page: 1, limit: 50 }).offset).toBe(0)
  })
})

describe('report/fraudIncidents — mapFraudRow', () => {
  it('should map camelCase columns to the snake_case response shape', () => {
    expect(mapFraudRow(baseRecord)).toEqual({
      id: 'f-1',
      user_id: 'u-1',
      fraud_type: 'VELOCITY_ANOMALY',
      severity: 'HIGH',
      claimed_lat: -6.2,
      claimed_lng: 106.8,
      calculated_speed_kmh: 240.5,
      action_taken: 'BLOCK',
      created_at: '2025-06-15T08:30:00.000Z',
    })
  })

  it('should coalesce a null severity to the DB default LOW', () => {
    expect(mapFraudRow({ ...baseRecord, severity: null }).severity).toBe('LOW')
  })

  it('should coalesce a null action_taken to the DB default SOFT_REJECT', () => {
    expect(mapFraudRow({ ...baseRecord, actionTaken: null }).action_taken).toBe('SOFT_REJECT')
  })

  it('should preserve null coordinates and speed', () => {
    const row = mapFraudRow({
      ...baseRecord,
      claimedLat: null,
      claimedLng: null,
      calculatedSpeedKmh: null,
    })
    expect(row.claimed_lat).toBeNull()
    expect(row.claimed_lng).toBeNull()
    expect(row.calculated_speed_kmh).toBeNull()
  })

  it('should normalize created_at to an ISO date-time string', () => {
    const row = mapFraudRow({ ...baseRecord, createdAt: '2025-06-15 08:30:00+00' })
    expect(row.created_at).toBe('2025-06-15T08:30:00.000Z')
  })
})
