import { Elysia } from 'elysia'
import { Type, type Static } from '@sinclair/typebox'
import { sql as pgClient } from '../config/database'
import { redis } from '../config/redis'
import {
  buildGraduatedFraudResponse,
  resetFraudCount,
  type FraudDetection,
  type FraudResponseResult,
  type FraudTelemetryParams,
  type FraudType,
} from './fraudResponse'
import type { JWTClaims } from './tenantGuard'

// --- Constants ---

const ACCURACY_MIN_METERS = 3
const ACCURACY_MAX_METERS = 50
const CLOCK_DRIFT_THRESHOLD_SECONDS = 30
const VELOCITY_THRESHOLD_KMH = 120
const LAST_POS_TTL_SECONDS = 1800 // 30 minutes
const REDIS_KEY_PREFIX = 'antispoof:lastpos'

// --- TypeBox Schema for GPS Payload ---

export const GpsSubmissionSchema = Type.Object({
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lng: Type.Number({ minimum: -180, maximum: 180 }),
  accuracy: Type.Number({ minimum: 0 }),
  is_mock_provider: Type.Optional(Type.Boolean()),
  client_timestamp: Type.Number(),
  mono_delta_ms: Type.Optional(Type.Number()),
  device_info: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

export type GpsSubmission = Static<typeof GpsSubmissionSchema>

// --- Types ---

interface LastPosition {
  lat: number
  lng: number
  timestamp_ms: number
}

export interface GpsValidationResult {
  valid: boolean
  fraudResponse?: FraudResponseResult
  error?: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

// --- Redis helpers ---

function buildLastPosKey(userId: string): string {
  return `${REDIS_KEY_PREFIX}:${userId}`
}

async function getLastPosition(userId: string): Promise<LastPosition | null> {
  const raw = await redis.get(buildLastPosKey(userId))
  if (!raw) return null
  return JSON.parse(raw) as LastPosition
}

async function setLastPosition(userId: string, pos: LastPosition): Promise<void> {
  await redis.set(
    buildLastPosKey(userId),
    JSON.stringify(pos),
    'EX',
    LAST_POS_TTL_SECONDS,
  )
}

// --- Validation Logic ---

function checkMockProvider(gps: GpsSubmission): FraudDetection | null {
  if (gps.is_mock_provider === true) {
    return {
      type: 'MOCK_LOCATION',
      severity: 'MEDIUM',
      details: { is_mock_provider: true },
    }
  }
  return null
}

function checkAccuracy(gps: GpsSubmission): FraudDetection | null {
  if (gps.accuracy < ACCURACY_MIN_METERS || gps.accuracy > ACCURACY_MAX_METERS) {
    return {
      type: 'ACCURACY_EXCESS',
      severity: 'LOW',
      details: {
        accuracy_meters: gps.accuracy,
        valid_range: `${ACCURACY_MIN_METERS}-${ACCURACY_MAX_METERS}m`,
      },
    }
  }
  return null
}

function checkClockDrift(gps: GpsSubmission, serverNowMs: number): FraudDetection | null {
  const driftMs = Math.abs(serverNowMs - gps.client_timestamp)
  const driftSeconds = driftMs / 1000

  if (driftSeconds > CLOCK_DRIFT_THRESHOLD_SECONDS) {
    return {
      type: 'CLOCK_DRIFT',
      severity: 'MEDIUM',
      details: {
        clock_drift_seconds: Math.round(driftSeconds * 100) / 100,
        threshold_seconds: CLOCK_DRIFT_THRESHOLD_SECONDS,
        client_timestamp: gps.client_timestamp,
        server_timestamp: serverNowMs,
      },
    }
  }
  return null
}

async function checkVelocity(
  userId: string,
  gps: GpsSubmission,
): Promise<FraudDetection | null> {
  const lastPos = await getLastPosition(userId)
  if (!lastPos) return null

  const timeDiffMs = gps.client_timestamp - lastPos.timestamp_ms
  if (timeDiffMs <= 0) return null

  const timeDiffSeconds = timeDiffMs / 1000
  if (timeDiffSeconds < 1) return null

  const result = await pgClient`
    SELECT ST_DistanceSphere(
      ST_MakePoint(${lastPos.lng}, ${lastPos.lat}),
      ST_MakePoint(${gps.lng}, ${gps.lat})
    ) AS distance_meters
  `

  const distanceMeters = Number(result[0]?.distance_meters ?? 0)
  const speedKmh = (distanceMeters / timeDiffSeconds) * 3.6

  if (speedKmh > VELOCITY_THRESHOLD_KMH) {
    return {
      type: 'VELOCITY_ANOMALY',
      severity: 'HIGH',
      details: {
        calculated_speed_kmh: Math.round(speedKmh * 100) / 100,
        threshold_kmh: VELOCITY_THRESHOLD_KMH,
        distance_meters: Math.round(distanceMeters * 100) / 100,
        time_seconds: Math.round(timeDiffSeconds * 100) / 100,
        from: { lat: lastPos.lat, lng: lastPos.lng },
        to: { lat: gps.lat, lng: gps.lng },
      },
    }
  }

  return null
}

// --- Fraud result builder (delegates to graduated response) ---

async function handleFraudDetected(
  claims: JWTClaims,
  gps: GpsSubmission,
  fraud: FraudDetection,
  requestEndpoint?: string,
  clientIp?: string,
  extraParams?: { calculatedSpeedKmh?: number; clockDriftSeconds?: number },
): Promise<GpsValidationResult> {
  const telemetryParams: FraudTelemetryParams = {
    companyId: claims.company_id,
    userId: claims.user_id,
    userRole: claims.role_label,
    fraudType: fraud.type,
    gps,
    calculatedSpeedKmh: extraParams?.calculatedSpeedKmh,
    clockDriftSeconds: extraParams?.clockDriftSeconds,
    requestEndpoint,
    clientIp,
  }

  const fraudResponse = await buildGraduatedFraudResponse(telemetryParams, fraud)

  return {
    valid: false,
    fraudResponse,
    error: fraudResponse.error,
  }
}

// --- Core validation function ---

async function validateGeoSubmissionImpl(
  claims: JWTClaims,
  gps: GpsSubmission,
  requestEndpoint?: string,
  clientIp?: string,
): Promise<GpsValidationResult> {
  const serverNowMs = Date.now()

  // Layer 1: Mock provider detection
  const mockFraud = checkMockProvider(gps)
  if (mockFraud) {
    return handleFraudDetected(claims, gps, mockFraud, requestEndpoint, clientIp)
  }

  // Layer 1: Accuracy range check
  const accuracyFraud = checkAccuracy(gps)
  if (accuracyFraud) {
    return handleFraudDetected(claims, gps, accuracyFraud, requestEndpoint, clientIp)
  }

  // Layer 2: Clock drift detection
  const clockFraud = checkClockDrift(gps, serverNowMs)
  if (clockFraud) {
    return handleFraudDetected(claims, gps, clockFraud, requestEndpoint, clientIp, {
      clockDriftSeconds: clockFraud.details['clock_drift_seconds'] as number,
    })
  }

  // Layer 3: Velocity check (PostGIS)
  const velocityFraud = await checkVelocity(claims.user_id, gps)
  if (velocityFraud) {
    return handleFraudDetected(claims, gps, velocityFraud, requestEndpoint, clientIp, {
      calculatedSpeedKmh: velocityFraud.details['calculated_speed_kmh'] as number,
    })
  }

  // All checks passed — update last known position and reset fraud counter
  await setLastPosition(claims.user_id, {
    lat: gps.lat,
    lng: gps.lng,
    timestamp_ms: gps.client_timestamp,
  })
  await resetFraudCount(claims.user_id)

  return { valid: true }
}

// --- Elysia Plugin ---

/**
 * Anti-spoofing Elysia plugin.
 * Derives `validateGeoSubmission` into the request context for selective use
 * by GPS-sensitive route handlers (attendance check-in, visit-in, etc.).
 *
 * Uses graduated fraud response: severity escalates with consecutive anomalies,
 * soft-rejects without banning, and flags for admin review after threshold.
 *
 * Must be applied AFTER tenantGuard so that `claims` is available.
 */
export const antiSpoof = new Elysia({ name: 'antiSpoof' })
  .derive(({ headers, path, ...ctx }) => {
    const claims = (ctx as unknown as { claims: JWTClaims | null }).claims
    const clientIp = headers['x-forwarded-for']?.split(',')[0]?.trim()
      ?? headers['x-real-ip']
      ?? null

    /**
     * Validates a GPS submission through all anti-spoofing layers.
     * Call this from route handlers that accept GPS coordinates.
     *
     * @returns GpsValidationResult with graduated fraud response if invalid
     */
    async function validateGeoSubmission(gps: GpsSubmission): Promise<GpsValidationResult> {
      if (!claims) {
        return {
          valid: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required for GPS validation',
            details: {},
          },
        }
      }

      return validateGeoSubmissionImpl(claims, gps, path, clientIp ?? undefined)
    }

    return { validateGeoSubmission }
  })
  .as('scoped')
