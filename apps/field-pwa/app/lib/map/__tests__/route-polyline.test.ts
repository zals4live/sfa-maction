import { describe, expect, it } from 'vitest'
import type { GeoPoint } from '@maction/types'
import { distanceBetweenPoints } from '@maction/utils'
import {
  routeCenter,
  toLatLng,
  totalRouteDistance,
  waypointLatLngs,
  type RouteWaypoint
} from '../route-polyline'

/** Ordered fixture route around Jakarta. */
const A: GeoPoint = { lat: -6.2, lng: 106.816666 }
const B: GeoPoint = { lat: -6.21, lng: 106.826666 }
const C: GeoPoint = { lat: -6.22, lng: 106.836666 }

function wp(name: string, point: GeoPoint): RouteWaypoint {
  return { name, point }
}

describe('toLatLng', () => {
  it('should map a GeoPoint to a [lat, lng] tuple', () => {
    expect(toLatLng(A)).toEqual([-6.2, 106.816666])
  })
})

describe('waypointLatLngs', () => {
  it('should map ordered waypoints to tuples preserving order', () => {
    const route = [wp('A', A), wp('B', B)]
    expect(waypointLatLngs(route)).toEqual([
      [-6.2, 106.816666],
      [-6.21, 106.826666]
    ])
  })

  it('should return an empty array for no waypoints', () => {
    expect(waypointLatLngs([])).toEqual([])
  })
})

describe('routeCenter', () => {
  it('should return null for an empty route', () => {
    expect(routeCenter([])).toBeNull()
  })

  it('should return the single point for a one-stop route', () => {
    expect(routeCenter([wp('A', A)])).toEqual([A.lat, A.lng])
  })

  it('should return the centroid (average) of all waypoints', () => {
    const [lat, lng] = routeCenter([wp('A', A), wp('B', B), wp('C', C)])!
    expect(lat).toBeCloseTo((A.lat + B.lat + C.lat) / 3, 10)
    expect(lng).toBeCloseTo((A.lng + B.lng + C.lng) / 3, 10)
  })
})

describe('totalRouteDistance', () => {
  it('should be zero for an empty route', () => {
    expect(totalRouteDistance([])).toBe(0)
  })

  it('should be zero for a single-stop route (no legs)', () => {
    expect(totalRouteDistance([wp('A', A)])).toBe(0)
  })

  it('should sum consecutive leg distances', () => {
    const route = [wp('A', A), wp('B', B), wp('C', C)]
    const expected
      = distanceBetweenPoints(A, B) + distanceBetweenPoints(B, C)
    expect(totalRouteDistance(route)).toBeCloseTo(expected, 6)
  })

  it('should match a single leg for a two-stop route', () => {
    expect(totalRouteDistance([wp('A', A), wp('B', B)])).toBeCloseTo(
      distanceBetweenPoints(A, B),
      6
    )
  })
})
