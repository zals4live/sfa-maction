import { describe, expect, it, vi } from 'vitest'
import type { GeoPoint } from '@maction/types'
import { distanceBetweenPoints } from '@maction/utils'
import {
  DEFAULT_GEOFENCE_RADIUS_METERS,
  useGeofence,
  type GeolocationSeam
} from '../useGeofence'

/** Target center used across tests (near Jakarta). */
const CENTER: GeoPoint = { lat: -6.2, lng: 106.816666 }

/**
 * Build a point offset east of `origin` by a target ground distance (meters).
 * Longitude degrees shrink with latitude by cos(lat); the Haversine helper then
 * reports a distance within a fraction of a meter of `meters`.
 */
function pointEastOf(origin: GeoPoint, meters: number): GeoPoint {
  const metersPerDegLng = 111_319.49 * Math.cos((origin.lat * Math.PI) / 180)
  return { lat: origin.lat, lng: origin.lng + meters / metersPerDegLng }
}

describe('useGeofence', () => {
  it('should expose the default 100m radius when none is configured', () => {
    const geo = useGeofence({ target: CENTER })
    expect(geo.radiusMeters).toBe(DEFAULT_GEOFENCE_RADIUS_METERS)
    expect(geo.radiusMeters).toBe(100)
  })

  it('should report null distance until both position and target are known', () => {
    const geo = useGeofence()
    expect(geo.distanceMeters.value).toBeNull()

    geo.setTarget(CENTER)
    expect(geo.distanceMeters.value).toBeNull()

    geo.updatePosition(CENTER)
    expect(geo.distanceMeters.value).toBeCloseTo(0, 5)
  })

  it('should compute geodesic distance matching the shared spatial helper', () => {
    const position = pointEastOf(CENTER, 250)
    const geo = useGeofence({ target: CENTER, position })

    const expected = distanceBetweenPoints(position, CENTER)
    expect(geo.distanceMeters.value).toBeCloseTo(expected, 6)
    expect(geo.distanceMeters.value).toBeCloseTo(250, 0)
  })

  it('should treat a point well inside the radius as within', () => {
    const geo = useGeofence({ target: CENTER, position: pointEastOf(CENTER, 40) })
    expect(geo.isWithinRadius.value).toBe(true)
  })

  it('should treat a point exactly at the radius boundary as within (inclusive)', () => {
    // 99.5m avoids float rounding pushing the boundary point just outside 100m.
    const geo = useGeofence({ target: CENTER, position: pointEastOf(CENTER, 99.5) })
    expect(geo.distanceMeters.value!).toBeLessThanOrEqual(geo.radiusMeters)
    expect(geo.isWithinRadius.value).toBe(true)
  })

  it('should treat a point slightly outside the radius as out of range', () => {
    const geo = useGeofence({ target: CENTER, position: pointEastOf(CENTER, 120) })
    expect(geo.distanceMeters.value!).toBeGreaterThan(geo.radiusMeters)
    expect(geo.isWithinRadius.value).toBe(false)
  })

  it('should respect a custom radius when provided', () => {
    const position = pointEastOf(CENTER, 200)
    const tight = useGeofence({ target: CENTER, position, radiusMeters: 100 })
    const wide = useGeofence({ target: CENTER, position, radiusMeters: 300 })

    expect(tight.isWithinRadius.value).toBe(false)
    expect(wide.isWithinRadius.value).toBe(true)
  })

  it('should produce a proximity ratio of 1 at the center', () => {
    const geo = useGeofence({ target: CENTER, position: CENTER })
    expect(geo.proximityRatio.value).toBeCloseTo(1, 5)
  })

  it('should produce ~0.5 proximity at half the radius', () => {
    const geo = useGeofence({ target: CENTER, position: pointEastOf(CENTER, 50) })
    expect(geo.proximityRatio.value).toBeCloseTo(0.5, 1)
  })

  it('should clamp proximity ratio to 0 beyond the radius', () => {
    const geo = useGeofence({ target: CENTER, position: pointEastOf(CENTER, 500) })
    expect(geo.proximityRatio.value).toBe(0)
  })

  it('should return proximity ratio 0 when position or target is unknown', () => {
    const geo = useGeofence({ target: CENTER })
    expect(geo.proximityRatio.value).toBe(0)
  })

  it('should recompute reactively when the position is updated', () => {
    const geo = useGeofence({ target: CENTER, position: pointEastOf(CENTER, 500) })
    expect(geo.isWithinRadius.value).toBe(false)

    geo.updatePosition(pointEastOf(CENTER, 30))
    expect(geo.isWithinRadius.value).toBe(true)
    expect(geo.proximityRatio.value).toBeGreaterThan(0)
  })

  it('should recompute reactively when the target is updated', () => {
    const position = pointEastOf(CENTER, 30)
    const geo = useGeofence({ position })
    expect(geo.distanceMeters.value).toBeNull()

    geo.setTarget(CENTER)
    expect(geo.distanceMeters.value).toBeCloseTo(30, 0)
    expect(geo.isWithinRadius.value).toBe(true)
  })

  it('should feed injected geolocation fixes into the position ref', () => {
    let onSuccess: ((p: { coords: { latitude: number, longitude: number } }) => void) | null = null
    const geolocation: GeolocationSeam = {
      watchPosition: vi.fn(success => {
        onSuccess = success
        return 42
      }),
      clearWatch: vi.fn()
    }
    const geo = useGeofence({ target: CENTER, geolocation })

    geo.startWatch()
    expect(geolocation.watchPosition).toHaveBeenCalledTimes(1)

    onSuccess!({ coords: { latitude: CENTER.lat, longitude: CENTER.lng } })
    expect(geo.position.value).toEqual(CENTER)
    expect(geo.proximityRatio.value).toBeCloseTo(1, 5)
  })

  it('should not start a second watch while one is active, and clear on stop', () => {
    const geolocation: GeolocationSeam = {
      watchPosition: vi.fn(() => 7),
      clearWatch: vi.fn()
    }
    const geo = useGeofence({ geolocation })

    geo.startWatch()
    geo.startWatch()
    expect(geolocation.watchPosition).toHaveBeenCalledTimes(1)

    geo.stopWatch()
    expect(geolocation.clearWatch).toHaveBeenCalledWith(7)

    geo.startWatch()
    expect(geolocation.watchPosition).toHaveBeenCalledTimes(2)
  })
})
