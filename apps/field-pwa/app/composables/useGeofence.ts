/**
 * `useGeofence` — geodesic distance, proximity validation, and radar state.
 *
 * Powers the visit-in / check-in geofence experience for the Field PWA (Salesman & MR):
 *  - Track the user's current GPS position and a settable target center (outlet/soffice).
 *  - Expose the reactive geodesic distance between them and whether the user is inside
 *    the configured geofence radius (default 100m per product steering).
 *  - Derive a clamped 0..1 `proximityRatio` (1 = at the center, 0 = at/beyond the radius)
 *    suitable for driving a pulsing Leaflet `GeofenceRadar` visualization.
 *
 * All spatial math is delegated to the shared `@maction/utils` helpers — this composable
 * never reimplements Haversine. Geolocation is injectable so tests feed positions directly
 * and never touch the real `navigator.geolocation`; the live watch is opt-in at runtime.
 */
import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue'
import type { GeoPoint } from '@maction/types'
import { distanceBetweenPoints, isWithinGeofence } from '@maction/utils'

/** Product default geofence proximity threshold, in meters. */
export const DEFAULT_GEOFENCE_RADIUS_METERS = 100

/** Minimal geolocation seam — satisfied by `navigator.geolocation` or a test fake. */
export interface GeolocationSeam {
  watchPosition: (
    onSuccess: (position: { coords: { latitude: number, longitude: number } }) => void,
    onError?: (error: unknown) => void,
    options?: PositionOptions
  ) => number
  clearWatch: (watchId: number) => void
}

/** Options for {@link useGeofence}; all optional so runtime and tests can diverge. */
export interface GeofenceOptions {
  /** Geofence proximity threshold in meters. Defaults to {@link DEFAULT_GEOFENCE_RADIUS_METERS}. */
  radiusMeters?: number
  /** Initial target center (outlet/soffice location); may be set later via `setTarget`. */
  target?: GeoPoint | null
  /** Initial current position; may be set later via `updatePosition`. */
  position?: GeoPoint | null
  /** Override the geolocation provider (tests inject a fake; runtime falls back to `navigator`). */
  geolocation?: GeolocationSeam
}

/** Public surface returned by {@link useGeofence}. */
export interface GeofenceApi {
  /** The user's current GPS position, or `null` until a fix arrives. */
  position: Readonly<Ref<GeoPoint | null>>
  /** The geofence target center (outlet/soffice), or `null` until set. */
  target: Readonly<Ref<GeoPoint | null>>
  /** Configured geofence radius in meters. */
  radiusMeters: number
  /** Geodesic distance (meters) between position and target, or `null` if either is missing. */
  distanceMeters: ComputedRef<number | null>
  /** Whether the current position is within the configured radius of the target. */
  isWithinRadius: ComputedRef<boolean>
  /** Clamped 0..1 proximity: 1 at the center, 0 at/beyond the radius. `0` when unknown. */
  proximityRatio: ComputedRef<number>
  /** Replace the current GPS position. */
  updatePosition: (next: GeoPoint | null) => void
  /** Replace the geofence target center. */
  setTarget: (next: GeoPoint | null) => void
  /** Begin watching the live geolocation provider, feeding fixes into `position`. */
  startWatch: (options?: PositionOptions) => void
  /** Stop the live geolocation watch, if any. */
  stopWatch: () => void
}

/** Resolve the runtime geolocation provider, or `null` where the API is unavailable. */
function resolveGeolocation(): GeolocationSeam | null {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null
  const geo = navigator.geolocation
  return {
    watchPosition: (onSuccess, onError, options) =>
      geo.watchPosition(onSuccess, onError, options),
    clearWatch: watchId => geo.clearWatch(watchId)
  }
}

export function useGeofence(options: GeofenceOptions = {}): GeofenceApi {
  const radiusMeters = options.radiusMeters ?? DEFAULT_GEOFENCE_RADIUS_METERS
  const geolocation = options.geolocation ?? null

  const position = ref<GeoPoint | null>(options.position ?? null)
  const target = ref<GeoPoint | null>(options.target ?? null)
  let watchId: number | null = null

  const distanceMeters = computed<number | null>(() => {
    if (!position.value || !target.value) return null
    return distanceBetweenPoints(position.value, target.value)
  })

  const isWithinRadius = computed<boolean>(() => {
    if (!position.value || !target.value) return false
    return isWithinGeofence(position.value, target.value, radiusMeters)
  })

  const proximityRatio = computed<number>(() => {
    const distance = distanceMeters.value
    if (distance === null) return 0
    // 1 at the center, decaying linearly to 0 at the radius; clamped outside the fence.
    const ratio = 1 - distance / radiusMeters
    return Math.min(1, Math.max(0, ratio))
  })

  function updatePosition(next: GeoPoint | null): void {
    position.value = next
  }

  function setTarget(next: GeoPoint | null): void {
    target.value = next
  }

  function startWatch(watchOptions?: PositionOptions): void {
    const provider = geolocation ?? resolveGeolocation()
    if (!provider || watchId !== null) return
    watchId = provider.watchPosition(
      ({ coords }) => {
        position.value = { lat: coords.latitude, lng: coords.longitude }
      },
      undefined,
      watchOptions ?? { enableHighAccuracy: true }
    )
  }

  function stopWatch(): void {
    if (watchId === null) return
    const provider = geolocation ?? resolveGeolocation()
    provider?.clearWatch(watchId)
    watchId = null
  }

  return {
    position: readonly(position) as Readonly<Ref<GeoPoint | null>>,
    target: readonly(target) as Readonly<Ref<GeoPoint | null>>,
    radiusMeters,
    distanceMeters,
    isWithinRadius,
    proximityRatio,
    updatePosition,
    setTarget,
    startWatch,
    stopWatch
  }
}
