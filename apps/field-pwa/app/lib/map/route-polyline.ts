/**
 * Pure helpers for `RoutePolyline.vue`.
 *
 * Extracted from the SFC (mirroring the `visit-in.ts` sibling-helper pattern) so the
 * browser-free geometry — latlng mapping, bounds/center computation, and the total-route
 * distance sum — can be unit-tested in a node environment without mounting the Leaflet map
 * or a Vue component. The SFC consumes these directly inside `computed`.
 */
import type { GeoPoint } from '@maction/types'
import { distanceBetweenPoints } from '@maction/utils'

/** A single ordered stop on the daily route: an outlet/doctor with a display name. */
export interface RouteWaypoint {
  /** Display label shown on the marker tooltip (outlet/doctor name). */
  name: string
  /** Geographic location of the stop. */
  point: GeoPoint
}

/** Leaflet consumes `[lat, lng]` tuples. */
export type LatLngTuple = [number, number]

/** Map a `GeoPoint` to the `[lat, lng]` tuple Leaflet expects. */
export function toLatLng(point: GeoPoint): LatLngTuple {
  return [point.lat, point.lng]
}

/** Map ordered waypoints to the tuple array used by the polyline + markers. */
export function waypointLatLngs(waypoints: RouteWaypoint[]): LatLngTuple[] {
  return waypoints.map(waypoint => toLatLng(waypoint.point))
}

/**
 * Compute the map center as the average of all waypoint coordinates (a cheap centroid).
 * Returns `null` for an empty route so the SFC can render its placeholder instead of a map.
 */
export function routeCenter(waypoints: RouteWaypoint[]): LatLngTuple | null {
  if (waypoints.length === 0) return null
  const sum = waypoints.reduce(
    (acc, { point }) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 }
  )
  return [sum.lat / waypoints.length, sum.lng / waypoints.length]
}

/**
 * Sum the geodesic distance of consecutive legs along the ordered route, in meters.
 * A route with fewer than two stops has no legs, so the total is zero.
 */
export function totalRouteDistance(waypoints: RouteWaypoint[]): number {
  let total = 0
  for (let i = 1; i < waypoints.length; i++) {
    total += distanceBetweenPoints(waypoints[i - 1]!.point, waypoints[i]!.point)
  }
  return total
}
