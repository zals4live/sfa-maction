import { describe, expect, it } from 'vitest'
import { UserRole } from '@maction/types'
import {
  ROLE_COLOR,
  colorFor,
  toLatLng,
  trailFor,
  hasTrail,
  formatTimestamp,
  type PlottableUser,
  type TrailPoint
} from '../live-tracking'

/** Build a plottable-user fixture, overriding fields per test. */
function makeUser(overrides: Partial<PlottableUser> = {}): PlottableUser {
  return {
    role_label: UserRole.SALESMAN,
    lat: -6.2,
    lng: 106.8,
    breadcrumbs: [],
    ...overrides
  }
}

/** Build a breadcrumb trail point. */
function crumb(lat: number, lng: number): TrailPoint {
  return { lat, lng, timestamp: '2024-01-01T00:00:00Z' }
}

describe('live-tracking helpers', () => {
  describe('colorFor', () => {
    it('resolves the Salesman token for the SALESMAN role', () => {
      expect(colorFor(UserRole.SALESMAN)).toBe(ROLE_COLOR[UserRole.SALESMAN])
    })

    it('resolves the MR token for the MR role', () => {
      expect(colorFor(UserRole.MR)).toBe(ROLE_COLOR[UserRole.MR])
    })

    it('visually distinguishes the two field roles', () => {
      expect(colorFor(UserRole.SALESMAN)).not.toBe(colorFor(UserRole.MR))
    })

    it('falls back to the Salesman token for an unknown role', () => {
      const unknownRole = 'ADMIN_CABANG' as unknown as UserRole.SALESMAN
      expect(colorFor(unknownRole)).toBe(ROLE_COLOR[UserRole.SALESMAN])
    })
  })

  describe('toLatLng', () => {
    it('maps a lat/lng point to a Leaflet [lat, lng] tuple', () => {
      expect(toLatLng({ lat: -6.2, lng: 106.8 })).toEqual([-6.2, 106.8])
    })
  })

  describe('trailFor', () => {
    it('maps breadcrumbs to an ordered tuple list (oldest → newest)', () => {
      const user = makeUser({
        breadcrumbs: [crumb(-6.1, 106.7), crumb(-6.2, 106.8), crumb(-6.3, 106.9)]
      })
      expect(trailFor(user)).toEqual([
        [-6.1, 106.7],
        [-6.2, 106.8],
        [-6.3, 106.9]
      ])
    })

    it('returns an empty list when there are no breadcrumbs', () => {
      expect(trailFor(makeUser())).toEqual([])
    })
  })

  describe('hasTrail', () => {
    it('is false with zero or one breadcrumb (nothing to connect)', () => {
      expect(hasTrail(makeUser())).toBe(false)
      expect(hasTrail(makeUser({ breadcrumbs: [crumb(-6.2, 106.8)] }))).toBe(false)
    })

    it('is true with two or more breadcrumbs', () => {
      expect(hasTrail(makeUser({ breadcrumbs: [crumb(-6.1, 106.7), crumb(-6.2, 106.8)] }))).toBe(true)
    })
  })

  describe('formatTimestamp', () => {
    it('returns a dash for an unparseable timestamp', () => {
      expect(formatTimestamp('not-a-date')).toBe('—')
    })

    it('returns a non-empty time string for a valid ISO timestamp', () => {
      const label = formatTimestamp('2024-01-01T08:30:00Z')
      expect(label).not.toBe('—')
      expect(label.length).toBeGreaterThan(0)
    })
  })
})
