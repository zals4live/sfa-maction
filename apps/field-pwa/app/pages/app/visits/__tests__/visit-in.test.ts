import { describe, expect, it } from 'vitest'
import type { GeoPoint, MasterCustomer } from '@maction/types'
import { CustomerType } from '@maction/types'
import {
  NEAR_PROXIMITY_THRESHOLD,
  canSubmitVisitIn,
  resolveRadarVisual,
  resolveTargetPoint
} from '../visit-in'

/** Target center used across tests (near Jakarta). */
const CENTER: GeoPoint = { lat: -6.2, lng: 106.816666 }

/** Build a minimal customer fixture; overrides tailor a single field per assertion. */
function makeCustomer(overrides: Partial<MasterCustomer> = {}): MasterCustomer {
  return {
    id: 'cust-1',
    company_id: 'co-1',
    soffice_id: 'so-1',
    customer_type: CustomerType.OUTLET,
    code: 'C-001',
    name: 'Apotek Sehat',
    address: 'Jl. Merdeka 1',
    city: null,
    province: null,
    phone: null,
    email: null,
    location_geom: CENTER,
    erp_customer_code: null,
    credit_limit: null,
    credit_used: null,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_at: '2025-01-15T00:00:00.000Z',
    updated_at: '2025-01-15T00:00:00.000Z',
    ...overrides
  }
}

describe('resolveTargetPoint', () => {
  it('should return the customer location when present', () => {
    expect(resolveTargetPoint(makeCustomer())).toEqual(CENTER)
  })

  it('should return null when the customer has no synced location', () => {
    expect(resolveTargetPoint(makeCustomer({ location_geom: null }))).toBeNull()
  })

  it('should return null when the customer is missing', () => {
    expect(resolveTargetPoint(null)).toBeNull()
    expect(resolveTargetPoint(undefined)).toBeNull()
  })
})

describe('resolveRadarVisual', () => {
  it('should be PENDING with zero intensity when distance is unknown', () => {
    expect(resolveRadarVisual(null, false, 0.9)).toEqual({ state: 'PENDING', intensity: 0 })
  })

  it('should be INSIDE when within the radius regardless of proximity', () => {
    expect(resolveRadarVisual(20, true, 0.8).state).toBe('INSIDE')
  })

  it('should be NEAR when outside but proximity meets the near threshold', () => {
    const visual = resolveRadarVisual(120, false, NEAR_PROXIMITY_THRESHOLD)
    expect(visual.state).toBe('NEAR')
  })

  it('should be FAR when outside and proximity is below the near threshold', () => {
    expect(resolveRadarVisual(500, false, 0.1).state).toBe('FAR')
  })

  it('should clamp intensity into the 0..1 range', () => {
    expect(resolveRadarVisual(10, true, 1.8).intensity).toBe(1)
    expect(resolveRadarVisual(500, false, -0.5).intensity).toBe(0)
  })
})

describe('canSubmitVisitIn', () => {
  it('should allow submit with a valid fix, inside the radius, not submitting', () => {
    expect(canSubmitVisitIn({ hasValidFix: true, isWithinRadius: true, submitting: false })).toBe(true)
  })

  it('should block submit when outside the radius', () => {
    expect(canSubmitVisitIn({ hasValidFix: true, isWithinRadius: false, submitting: false })).toBe(false)
  })

  it('should block submit without a trustworthy fix', () => {
    expect(canSubmitVisitIn({ hasValidFix: false, isWithinRadius: true, submitting: false })).toBe(false)
  })

  it('should block submit while a submit is already in flight', () => {
    expect(canSubmitVisitIn({ hasValidFix: true, isWithinRadius: true, submitting: true })).toBe(false)
  })
})
