/**
 * Pure helpers for `LiveTrackingMap.vue`.
 *
 * Extracted from the SFC (mirroring the field-pwa `route-polyline.ts` sibling-helper pattern)
 * so the browser-free presentation logic — role → marker color resolution, breadcrumb-trail
 * latlng mapping, and timestamp formatting — can be unit-tested in a node environment without
 * mounting the Leaflet map or a Vue component. The SFC consumes these directly. Nothing here
 * touches `window`, so it is safe to import during SSR or in tests.
 */
import { UserRole } from '@maction/types'

/** The two field roles surfaced on the tracking map (admins are never tracked). */
export type TrackedRole = UserRole.SALESMAN | UserRole.MR

/** A single GPS breadcrumb point on a field user's trail. */
export interface TrailPoint {
  lat: number
  lng: number
  /** ISO-8601 timestamp of the fix. */
  timestamp: string
}

/** Minimal shape a tracked field user must satisfy to be plotted. */
export interface PlottableUser {
  role_label: TrackedRole
  lat: number
  lng: number
  breadcrumbs: TrailPoint[]
}

/** Leaflet consumes `[lat, lng]` tuples. */
export type LatLngTuple = [number, number]

/**
 * Semantic role colors resolved from the KF Maction design tokens (see main.css). Leaflet
 * vector layers need concrete color values, so the token hexes are referenced here — they
 * mirror `bg-primary-500` (Salesman) and `bg-warning-500` (MR) used across the portal.
 */
export const ROLE_COLOR: Record<TrackedRole, string> = {
  [UserRole.SALESMAN]: '#1C4173',
  [UserRole.MR]: '#D97706'
}

/** Map a `{ lat, lng }` point to the `[lat, lng]` tuple Leaflet expects. */
export function toLatLng(point: { lat: number, lng: number }): LatLngTuple {
  return [point.lat, point.lng]
}

/** Resolve a marker/trail color for a role, defaulting to the Salesman token. */
export function colorFor(role: TrackedRole): string {
  return ROLE_COLOR[role] ?? ROLE_COLOR[UserRole.SALESMAN]
}

/** A user's breadcrumb trail (oldest → newest) as a lat/lng tuple list for the polyline. */
export function trailFor(user: PlottableUser): LatLngTuple[] {
  return user.breadcrumbs.map(toLatLng)
}

/** Whether a user has enough breadcrumbs (≥ 2 points) to draw a trail polyline. */
export function hasTrail(user: PlottableUser): boolean {
  return user.breadcrumbs.length > 1
}

/** Format an ISO timestamp for the marker tooltip (id-ID), or a dash when unparseable. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('id-ID')
}
