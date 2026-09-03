/**
 * Pure helpers for `RoutePolyline.vue`.
 *
 * Extracted from the SFC (mirroring the `visit-in.ts` sibling-helper pattern) so the
 * browser-free geometry — latlng mapping, geodesic arc densification (Turf.js great-circle),
 * bounds/center computation, and the total-route distance sum — can be unit-tested in a node
 * environment without mounting the Leaflet map or a Vue component. The SFC consumes these
 * directly inside `computed`. Turf.js is a pure JS geospatial library (no `window`), so it is
 * safe to import here and run during SSR or in tests.
 */
import { greatCircle } from '@turf/turf'
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

/** A rectangular map extent as `[southWest, northEast]` — what Leaflet's `fitBounds` expects. */
export type LatLngBounds = [LatLngTuple, LatLngTuple]

/** Points-per-leg for the densified great-circle arc; enough to look curved at city zoom. */
const ARC_POINTS_PER_LEG = 32

/** Map a `GeoPoint` to the `[lat, lng]` tuple Leaflet expects. */
export function toLatLng(point: GeoPoint): LatLngTuple {
  return [point.lat, point.lng]
}

/** Map ordered waypoints to the tuple array used for the numbered markers. */
export function waypointLatLngs(waypoints: RouteWaypoint[]): LatLngTuple[] {
  return waypoints.map(waypoint => toLatLng(waypoint.point))
}

/** Densify one leg into an ordered `[lat, lng]` arc using Turf's great-circle geodesic. */
function geodesicLeg(from: GeoPoint, to: GeoPoint): LatLngTuple[] {
  const arc = greatCircle([from.lng, from.lat], [to.lng, to.lat], {
    npoints: ARC_POINTS_PER_LEG
  })
  // greatCircle yields a LineString for antimeridian-free arcs; coords are [lng, lat].
  const coords = arc.geometry.coordinates as number[][]
  return coords.map(([lng, lat]) => [lat!, lng!] as LatLngTuple)
}

/**
 * Build the full geodesic polyline path across the ordered route as `[lat, lng]` tuples.
 * Each consecutive leg is densified into a great-circle arc so the rendered line follows the
 * earth's curvature rather than a flat Mercator straight line. Routes with fewer than two
 * stops have no drawable line, so an empty array is returned.
 */
export function routeGeodesicLatLngs(waypoints: RouteWaypoint[]): LatLngTuple[] {
  if (waypoints.length < 2) return []
  const path: LatLngTuple[] = []
  for (let i = 1; i < waypoints.length; i++) {
    const leg = geodesicLeg(waypoints[i - 1]!.point, waypoints[i]!.point)
    // Drop the first vertex of every leg after the first to avoid duplicate join points.
    path.push(...(i === 1 ? leg : leg.slice(1)))
  }
  return path
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
 * Compute the bounding box enclosing every waypoint as `[southWest, northEast]` for
 * `LMap.fitBounds`. Returns `null` for an empty route (nothing to frame).
 */
export function routeBounds(waypoints: RouteWaypoint[]): LatLngBounds | null {
  if (waypoints.length === 0) return null
  let minLat = Infinity
  let minLng = Infinity
  let maxLat = -Infinity
  let maxLng = -Infinity
  for (const { point } of waypoints) {
    minLat = Math.min(minLat, point.lat)
    minLng = Math.min(minLng, point.lng)
    maxLat = Math.max(maxLat, point.lat)
    maxLng = Math.max(maxLng, point.lng)
  }
  return [[minLat, minLng], [maxLat, maxLng]]
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
