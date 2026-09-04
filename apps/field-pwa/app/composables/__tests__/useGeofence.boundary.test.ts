import { describe, expect, it } from 'vitest'
import type { GeoPoint } from '@maction/types'
import { distanceBetweenPoints, isWithinGeofence } from '@maction/utils'
import { DEFAULT_GEOFENCE_RADIUS_METERS, useGeofence } from '../useGeofence'

/**
 * Geofence boundary-condition tests (Phase 16 integration validation).
 *
 * These tests pin down the *edge* behaviour of the 100m geofence used by both
 * GPS attendance check-in and field visit-in. The backend enforces the same
 * boundary with PostGIS `ST_DWithin(...)`, which is INCLUSIVE of the radius
 * (a point exactly `radius` meters away is considered within). The shared
 * client helper `isWithinGeofence` mirrors that with a `<=` comparison, and the
 * `useGeofence` composable delegates to it — so verifying the composable here
 * also locks in the shared helper's inclusive contract.
 *
 * Distances are constructed as true ground offsets (meters) east of a fixed
 * center; the Haversine helper then reports a distance within a fraction of a
 * meter of the requested value, letting us probe 99m / 100m / 101m precisely.
 */

/** Fixed target center (near Jakarta) reused across every case. */
const CENTER: GeoPoint = { lat: -6.2, lng: 106.816666 }

/** First-order meters per degree of longitude at the center's latitude. */
const METERS_PER_DEG_LNG = 111_319.49 * Math.cos((CENTER.lat * Math.PI) / 180)

/**
 * Build a point due east of {@link CENTER} whose measured Haversine distance is
 * `meters` to sub-millimeter accuracy. A first-order longitude offset lands a
 * fraction of a percent off, so we rescale by the ratio of desired-to-measured
 * distance — the Haversine distance is linear in a small east/west offset, so a
 * single correction converges the probe point onto its exact target distance.
 */
function pointAtDistance(meters: number): GeoPoint {
  const approxDeltaLng = meters / METERS_PER_DEG_LNG
  const approxPoint: GeoPoint = { lat: CENTER.lat, lng: CENTER.lng + approxDeltaLng }
  const measured = distanceBetweenPoints(approxPoint, CENTER)
  const correctedDeltaLng = approxDeltaLng * (meters / measured)
  return { lat: CENTER.lat, lng: CENTER.lng + correctedDeltaLng }
}

describe('useGeofence — boundary conditions', () => {
  const RADIUS = DEFAULT_GEOFENCE_RADIUS_METERS // 100m

  it('constructs probe points that land on their target distance (helper sanity)', () => {
    // Guards the test harness itself: if this drifts, the boundary assertions
    // below would be meaningless.
    expect(distanceBetweenPoints(pointAtDistance(99), CENTER)).toBeCloseTo(99, 3)
    expect(distanceBetweenPoints(pointAtDistance(100), CENTER)).toBeCloseTo(100, 3)
    expect(distanceBetweenPoints(pointAtDistance(101), CENTER)).toBeCloseTo(101, 3)
  })

  it('accepts a point slightly INSIDE the radius (99m → within)', () => {
    const geo = useGeofence({ target: CENTER, position: pointAtDistance(99) })

    expect(geo.distanceMeters.value!).toBeLessThan(RADIUS)
    expect(geo.isWithinRadius.value).toBe(true)
  })

  it('accepts a point EXACTLY at the radius boundary (100m → within, inclusive)', () => {
    const boundaryPoint = pointAtDistance(100)
    const geo = useGeofence({ target: CENTER, position: boundaryPoint })

    // The measured distance sits essentially on the fence (sub-millimeter).
    expect(geo.distanceMeters.value!).toBeCloseTo(RADIUS, 3)
    // Inclusive contract: exactly-at-radius is INSIDE, matching PostGIS ST_DWithin.
    expect(geo.isWithinRadius.value).toBe(true)
  })

  it('rejects a point slightly OUTSIDE the radius (101m → out of range)', () => {
    const geo = useGeofence({ target: CENTER, position: pointAtDistance(101) })

    expect(geo.distanceMeters.value!).toBeGreaterThan(RADIUS)
    expect(geo.isWithinRadius.value).toBe(false)
  })

  it('treats the boundary as inclusive at the shared-helper level (<=)', () => {
    // Directly exercise the shared spatial helper the backend velocity check and
    // the composable both rely on, using an exact synthetic distance so there is
    // no float ambiguity at the fence.
    const atRadius: GeoPoint = { lat: CENTER.lat, lng: CENTER.lng + RADIUS / METERS_PER_DEG_LNG }
    const measured = distanceBetweenPoints(atRadius, CENTER)

    // `isWithinGeofence` must agree with a `distance <= radius` comparison.
    expect(isWithinGeofence(atRadius, CENTER, measured)).toBe(true)
    // A radius one micro-meter below the measured distance flips it to outside,
    // proving the comparison is `<=` (inclusive) rather than `<` (exclusive).
    expect(isWithinGeofence(atRadius, CENTER, measured - 1e-6)).toBe(false)
  })

  it('respects a custom (tenant-configured) radius at its boundary', () => {
    // Pin the radius to the edge point's *own* measured distance so "exactly at
    // the fence" is exact rather than subject to float rounding around 250m.
    const edgePoint = pointAtDistance(250)
    const customRadius = distanceBetweenPoints(edgePoint, CENTER)

    const inside = useGeofence({
      target: CENTER,
      position: pointAtDistance(249),
      radiusMeters: customRadius
    })
    const atEdge = useGeofence({
      target: CENTER,
      position: edgePoint,
      radiusMeters: customRadius
    })
    const outside = useGeofence({
      target: CENTER,
      position: pointAtDistance(251),
      radiusMeters: customRadius
    })

    expect(inside.isWithinRadius.value).toBe(true)
    expect(atEdge.isWithinRadius.value).toBe(true) // inclusive: distance <= radius
    expect(outside.isWithinRadius.value).toBe(false)
  })

  it('drives proximity ratio to exactly 0 at the fence and > 0 just inside', () => {
    const atEdge = useGeofence({ target: CENTER, position: pointAtDistance(100) })
    const justInside = useGeofence({ target: CENTER, position: pointAtDistance(99) })

    // At the radius the linear ratio (1 - d/r) collapses to ~0 (clamped at 0).
    expect(atEdge.proximityRatio.value).toBeCloseTo(0, 2)
    expect(justInside.proximityRatio.value).toBeGreaterThan(0)
  })
})
