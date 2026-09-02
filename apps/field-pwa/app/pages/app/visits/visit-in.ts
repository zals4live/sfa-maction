/**
 * Pure helpers for the visit-in geofence page (`[id]/visit-in.vue`).
 *
 * Extracted from the SFC (mirroring the `visit-status.ts` / `default.nav.ts` pattern) so the
 * non-trivial, browser-free logic — target resolution, proximity→visual mapping, and the
 * submit-gating decision — can be unit-tested in a node environment without mounting the
 * Leaflet map or a Vue component. The page and `GeofenceRadar` consume these directly.
 */
import type { GeoPoint, MasterCustomer } from '@maction/types'

/** Visual state for the geofence radar, driven by proximity + inside/outside membership. */
export type RadarState = 'PENDING' | 'FAR' | 'NEAR' | 'INSIDE'

/** A resolved radar visual: the discrete state plus a clamped 0..1 pulse intensity. */
export interface RadarVisual {
  state: RadarState
  /** Pulse intensity for the animation, 0 (calm) .. 1 (strong); mirrors proximity when known. */
  intensity: number
}

/** Proximity ratio at/above which the user is considered "near" the target (not yet inside). */
export const NEAR_PROXIMITY_THRESHOLD = 0.5

/**
 * Resolve the geofence target coordinates for a plan from its cached customer.
 * The outlet/doctor location lives on `MasterCustomer.location_geom`; returns `null`
 * when the customer is missing or has no synced location so the caller can show a notice.
 */
export function resolveTargetPoint(customer: MasterCustomer | null | undefined): GeoPoint | null {
  return customer?.location_geom ?? null
}

/**
 * Map geofence readings into the radar visual. Membership wins over proximity: once inside
 * the radius the state is INSIDE; otherwise a higher proximity promotes FAR → NEAR. The
 * intensity clamps the proximity ratio so the SFC never has to sanitize animation input.
 */
export function resolveRadarVisual(
  distanceMeters: number | null,
  isWithinRadius: boolean,
  proximityRatio: number
): RadarVisual {
  const intensity = Math.min(1, Math.max(0, proximityRatio))
  if (distanceMeters === null) return { state: 'PENDING', intensity: 0 }
  if (isWithinRadius) return { state: 'INSIDE', intensity }
  if (intensity >= NEAR_PROXIMITY_THRESHOLD) return { state: 'NEAR', intensity }
  return { state: 'FAR', intensity }
}

/** Preconditions that gate the "Visit In" submit action. */
export interface SubmitGateInput {
  /** A trustworthy GPS fix has passed the anti-spoof accuracy/mock window. */
  hasValidFix: boolean
  /** The current position is inside the configured geofence radius. */
  isWithinRadius: boolean
  /** A submit is already in flight. */
  submitting: boolean
}

/**
 * Decide whether the visit-in submit is allowed. Requires a trustworthy fix, presence inside
 * the geofence radius (the soft gate — outside is blocked, never banned), and no in-flight
 * submit. Kept pure so the gating rule is unit-tested independently of the SFC and Leaflet.
 */
export function canSubmitVisitIn(input: SubmitGateInput): boolean {
  return input.hasValidFix && input.isWithinRadius && !input.submitting
}
