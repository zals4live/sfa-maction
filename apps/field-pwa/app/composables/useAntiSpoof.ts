/**
 * `useAntiSpoof` — client-side geolocation & clock hardening for the Field PWA.
 *
 * Implements the two browser-side layers of the anti-spoofing defense (Salesman & MR):
 *  - Layer 1 (Mock location detection): inspect OS mock flags surfaced on a position and
 *    enforce a sane GPS accuracy window (3m ≤ accuracy ≤ 50m). Out-of-window fixes are a
 *    SOFT rejection — the current action is blocked, the user is never banned.
 *  - Layer 2 (Monotonic clock anchoring): capture `performance.now()` hardware deltas
 *    alongside `Date.now()` wall-clock deltas, `anchor()` a baseline, then flag divergence
 *    beyond 30s or any backwards time jump as `CLOCK_DRIFT`.
 *
 * The composable only *evaluates* positions/timestamps and *builds* a telemetry object
 * shaped for the local outbox / `audit_fraud_telemetry` sync. It performs no network calls
 * and no Dexie writes — persistence is owned by the outbox/background-sync composables.
 * Server-side velocity checks (`VELOCITY_ANOMALY`, Layer 3) live in the Elysia backend and
 * are intentionally NOT emitted here.
 *
 * Clock/time providers are injectable so tests feed deterministic values and never touch
 * the real `Date.now`, `performance.now`, or `navigator`; runtime falls back to globals.
 */
import { readonly, ref, type Ref } from 'vue'
import { FraudType, type GeoPoint } from '@maction/types'

/** Minimum trustworthy GPS accuracy, in meters (tighter than this is implausible). */
export const MIN_ACCURACY_METERS = 3

/** Maximum trustworthy GPS accuracy, in meters (looser than this is rejected). */
export const MAX_ACCURACY_METERS = 50

/** Maximum tolerated divergence between wall-clock and monotonic elapsed time, in ms. */
export const MAX_CLOCK_DRIFT_MS = 30_000

/** Client-detectable fraud types (Layer 1 + Layer 2). `VELOCITY_ANOMALY` is server-side. */
export type ClientFraudType
  = | FraudType.MOCK_LOCATION
    | FraudType.ACCURACY_EXCESS
    | FraudType.CLOCK_DRIFT

/** A GPS fix as evaluated by Layer 1; mirrors the browser `GeolocationCoordinates` subset. */
export interface EvaluatedPosition {
  /** Latitude in decimal degrees. */
  lat: number
  /** Longitude in decimal degrees. */
  lng: number
  /** Reported horizontal accuracy in meters. */
  accuracy: number
  /** Optional OS mock indicator (some Android/WebView builds expose this). */
  mocked?: boolean
  /** Alternate mock indicator name seen on some platforms. */
  isMock?: boolean
}

/** Successful evaluation — the action may proceed. */
export interface EvaluationOk {
  ok: true
}

/** Failed evaluation — caller performs a SOFT rejection (block action, do not ban). */
export interface EvaluationRejected {
  ok: false
  fraudType: ClientFraudType
  message: string
  details: Record<string, unknown>
}

/** Discriminated result of any anti-spoof evaluation. */
export type EvaluationResult = EvaluationOk | EvaluationRejected

/** Telemetry record shaped for the local outbox / `audit_fraud_telemetry` sync. */
export interface FraudTelemetry {
  fraud_type: ClientFraudType
  claimed_lat: number | null
  claimed_lng: number | null
  accuracy_meters: number | null
  device_info: { userAgent: string | null }
  raw_payload: Record<string, unknown>
  wall_clock_ms: number
  monotonic_ms: number
}

/** Injectable time/device seams so tests never touch real globals. */
export interface AntiSpoofOptions {
  /** Wall-clock source; defaults to `Date.now`. */
  now?: () => number
  /** Monotonic hardware clock source; defaults to `performance.now`. */
  monotonic?: () => number
  /** User-agent source for telemetry; defaults to `navigator.userAgent`. */
  userAgent?: () => string | null
}

/** Public surface returned by {@link useAntiSpoof}. */
export interface AntiSpoofApi {
  /** The most recent evaluation result, or `null` before any evaluation. */
  lastResult: Readonly<Ref<EvaluationResult | null>>
  /** Whether a clock baseline has been anchored. */
  isAnchored: Readonly<Ref<boolean>>
  /** Layer 1: evaluate a GPS fix for mock flags and accuracy window. */
  evaluatePosition: (position: EvaluatedPosition) => EvaluationResult
  /** Layer 2: capture the current wall-clock + monotonic baseline. */
  anchor: () => void
  /** Layer 2: validate elapsed time since `anchor()` for drift or backwards jumps. */
  validateClock: () => EvaluationResult
  /** Build a telemetry record for a rejection, for the outbox to persist. */
  buildTelemetry: (
    rejection: EvaluationRejected,
    position?: EvaluatedPosition | GeoPoint | null
  ) => FraudTelemetry
}

/** Resolve a wall-clock source, falling back to `Date.now`. */
function resolveNow(now?: () => number): () => number {
  return now ?? (() => Date.now())
}

/** Resolve a monotonic source, falling back to `performance.now` or wall-clock. */
function resolveMonotonic(monotonic?: () => number): () => number {
  if (monotonic) return monotonic
  if (typeof performance !== 'undefined') return () => performance.now()
  return () => Date.now()
}

/** Resolve a user-agent source, falling back to `navigator.userAgent`. */
function resolveUserAgent(userAgent?: () => string | null): () => string | null {
  if (userAgent) return userAgent
  return () => (typeof navigator === 'undefined' ? null : navigator.userAgent)
}

/** True when a position carries any OS-level mock indicator. */
function isMocked(position: EvaluatedPosition): boolean {
  return position.mocked === true || position.isMock === true
}

export function useAntiSpoof(options: AntiSpoofOptions = {}): AntiSpoofApi {
  const now = resolveNow(options.now)
  const monotonic = resolveMonotonic(options.monotonic)
  const userAgent = resolveUserAgent(options.userAgent)

  const lastResult = ref<EvaluationResult | null>(null)
  const isAnchored = ref(false)
  let anchorWall = 0
  let anchorMono = 0

  function evaluatePosition(position: EvaluatedPosition): EvaluationResult {
    if (isMocked(position)) {
      return record({
        ok: false,
        fraudType: FraudType.MOCK_LOCATION,
        message: 'Location provider reported a mocked position.',
        details: { lat: position.lat, lng: position.lng }
      })
    }
    if (
      position.accuracy < MIN_ACCURACY_METERS
      || position.accuracy > MAX_ACCURACY_METERS
    ) {
      return record({
        ok: false,
        fraudType: FraudType.ACCURACY_EXCESS,
        message: `GPS accuracy ${position.accuracy}m is outside the trusted `
          + `${MIN_ACCURACY_METERS}-${MAX_ACCURACY_METERS}m window.`,
        details: {
          accuracy_meters: position.accuracy,
          min: MIN_ACCURACY_METERS,
          max: MAX_ACCURACY_METERS
        }
      })
    }
    return record({ ok: true })
  }

  function anchor(): void {
    anchorWall = now()
    anchorMono = monotonic()
    isAnchored.value = true
  }

  function validateClock(): EvaluationResult {
    if (!isAnchored.value) return record({ ok: true })
    const wallElapsed = now() - anchorWall
    const monoElapsed = monotonic() - anchorMono
    if (wallElapsed < 0) {
      return record(driftRejection('Wall clock moved backwards.', wallElapsed, monoElapsed))
    }
    if (Math.abs(wallElapsed - monoElapsed) > MAX_CLOCK_DRIFT_MS) {
      return record(driftRejection('Clock drift exceeded tolerance.', wallElapsed, monoElapsed))
    }
    return record({ ok: true })
  }

  function buildTelemetry(
    rejection: EvaluationRejected,
    position?: EvaluatedPosition | GeoPoint | null
  ): FraudTelemetry {
    const accuracy = position && 'accuracy' in position ? position.accuracy : null
    return {
      fraud_type: rejection.fraudType,
      claimed_lat: position?.lat ?? null,
      claimed_lng: position?.lng ?? null,
      accuracy_meters: accuracy,
      device_info: { userAgent: userAgent() },
      raw_payload: { message: rejection.message, ...rejection.details },
      wall_clock_ms: now(),
      monotonic_ms: monotonic()
    }
  }

  /** Store and return a result so `lastResult` always mirrors the latest evaluation. */
  function record(result: EvaluationResult): EvaluationResult {
    lastResult.value = result
    return result
  }

  return {
    lastResult: readonly(lastResult) as Readonly<Ref<EvaluationResult | null>>,
    isAnchored: readonly(isAnchored) as Readonly<Ref<boolean>>,
    evaluatePosition,
    anchor,
    validateClock,
    buildTelemetry
  }
}

/** Build a `CLOCK_DRIFT` rejection with elapsed-time diagnostics. */
function driftRejection(
  message: string,
  wallElapsed: number,
  monoElapsed: number
): EvaluationRejected {
  return {
    ok: false,
    fraudType: FraudType.CLOCK_DRIFT,
    message,
    details: { wall_elapsed_ms: wallElapsed, monotonic_elapsed_ms: monoElapsed }
  }
}
