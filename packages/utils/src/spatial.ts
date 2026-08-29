/**
 * Spatial utility helpers for geodesic calculations.
 *
 * Uses Turf.js for client-side geospatial math including
 * distance calculations, geofence checks, and route geometry.
 */

import type { GeoPoint } from '@maction/types';

/**
 * Calculate the Haversine distance between two geographic points in meters.
 */
export function distanceBetweenPoints(
  from: GeoPoint,
  to: GeoPoint
): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) *
      Math.cos(toRad(to.lat)) *
      Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Check if a point is within a given radius (meters) of a center point.
 */
export function isWithinGeofence(
  point: GeoPoint,
  center: GeoPoint,
  radiusMeters: number
): boolean {
  return distanceBetweenPoints(point, center) <= radiusMeters;
}

/**
 * Calculate speed in km/h between two GPS submissions.
 */
export function calculateSpeedKmh(
  from: GeoPoint,
  to: GeoPoint,
  elapsedSeconds: number
): number {
  if (elapsedSeconds <= 0) return 0;
  const distanceMeters = distanceBetweenPoints(from, to);
  return (distanceMeters / elapsedSeconds) * 3.6;
}
