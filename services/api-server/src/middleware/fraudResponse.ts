import { redis } from '../config/redis'
import { recordFraudTelemetry } from '../modules/audit/fraudTelemetryService'
import type { GpsSubmission } from './antiSpoof'

// --- Constants ---

const FRAUD_COUNT_TTL_SECONDS = 86_400 // 24 hours
const FRAUD_COUNT_PREFIX = 'fraud:count'
const ADMIN_NOTIFY_THRESHOLD = 6

// --- Types ---

export type FraudType = 'MOCK_LOCATION' | 'VELOCITY_ANOMALY' | 'ACCURACY_EXCESS' | 'CLOCK_DRIFT'
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface FraudDetection {
  type: FraudType
  severity: Severity
  details: Record<string, unknown>
}

export interface FraudResponseResult {
  blocked: true
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
  notification: {
    title: string
    message: string
    severity: Severity
  }
  adminNotifyRequired: boolean
  consecutiveCount: number
}

export interface FraudTelemetryParams {
  companyId: string
  userId: string
  userRole: string
  fraudType: FraudType
  gps: GpsSubmission
  calculatedSpeedKmh?: number
  clockDriftSeconds?: number
  requestEndpoint?: string
  clientIp?: string
}

// --- Base severity mapping by fraud type ---

const BASE_SEVERITY: Record<FraudType, Severity> = {
  MOCK_LOCATION: 'MEDIUM',
  VELOCITY_ANOMALY: 'HIGH',
  ACCURACY_EXCESS: 'LOW',
  CLOCK_DRIFT: 'MEDIUM',
}

// --- User-friendly notification messages ---

const NOTIFICATION_MESSAGES: Record<FraudType, string> = {
  MOCK_LOCATION: 'GPS verification detected a mock location provider. Please disable developer GPS tools and retry.',
  VELOCITY_ANOMALY: 'GPS verification detected an unusual travel speed between locations. Please wait and retry.',
  ACCURACY_EXCESS: 'GPS signal accuracy is outside the acceptable range. Please move to an open area and retry.',
  CLOCK_DRIFT: 'Device clock appears out of sync with the server. Please check your date/time settings and retry.',
}

// --- Redis key helpers ---

function buildFraudCountKey(userId: string): string {
  return `${FRAUD_COUNT_PREFIX}:${userId}`
}

// --- Core functions ---

async function incrementFraudCount(userId: string): Promise<number> {
  const key = buildFraudCountKey(userId)
  const count = await redis.incr(key)
  await redis.expire(key, FRAUD_COUNT_TTL_SECONDS)
  return count
}

export function computeEscalatedSeverity(baseSeverity: Severity, consecutiveCount: number): Severity {
  if (consecutiveCount >= 6) return 'CRITICAL'
  if (consecutiveCount >= 4) return 'HIGH'
  if (consecutiveCount >= 2) return 'MEDIUM'
  return baseSeverity
}

function buildNotification(fraudType: FraudType, severity: Severity): FraudResponseResult['notification'] {
  return {
    title: 'GPS Verification Failed',
    message: NOTIFICATION_MESSAGES[fraudType],
    severity,
  }
}

function buildErrorResponse(fraudType: FraudType, details: Record<string, unknown>): FraudResponseResult['error'] {
  return {
    code: 'GEOFENCE_SPOOF_DETECTED',
    message: NOTIFICATION_MESSAGES[fraudType],
    details,
  }
}

// --- Telemetry logging (fire-and-forget, non-blocking) ---

/**
 * Maps a fraud detection to the structured telemetry service, which performs
 * an RLS-scoped insert into audit_fraud_telemetry. Non-blocking by design —
 * the soft-rejection flow must never be delayed or failed by telemetry writes.
 */
function logFraudTelemetry(params: FraudTelemetryParams, severity: Severity): void {
  const { gps } = params

  recordFraudTelemetry(
    {
      companyId: params.companyId,
      userId: params.userId,
      userRole: params.userRole,
      clientIp: params.clientIp ?? null,
    },
    {
      fraudType: params.fraudType,
      severity,
      claimedLat: gps.lat,
      claimedLng: gps.lng,
      claimedAccuracyMeters: gps.accuracy,
      calculatedSpeedKmh: params.calculatedSpeedKmh ?? null,
      clockDriftSeconds: params.clockDriftSeconds ?? null,
      clientTimestamp: new Date(gps.client_timestamp).toISOString(),
      monoDeltaMs: gps.mono_delta_ms ?? null,
      deviceInfo: gps.device_info ?? null,
      isMockProvider: gps.is_mock_provider ?? false,
      rawPayload: gps as unknown as Record<string, unknown>,
      requestEndpoint: params.requestEndpoint ?? null,
      actionTaken: 'SOFT_REJECT',
    },
  )
}

// --- Main graduated fraud response function ---

export async function buildGraduatedFraudResponse(
  telemetryParams: FraudTelemetryParams,
  fraudDetection: FraudDetection,
): Promise<FraudResponseResult> {
  const consecutiveCount = await incrementFraudCount(telemetryParams.userId)
  const baseSeverity = BASE_SEVERITY[fraudDetection.type]
  const escalatedSeverity = computeEscalatedSeverity(baseSeverity, consecutiveCount)
  const adminNotifyRequired = consecutiveCount >= ADMIN_NOTIFY_THRESHOLD

  logFraudTelemetry(telemetryParams, escalatedSeverity)

  return {
    blocked: true,
    error: buildErrorResponse(fraudDetection.type, {
      ...fraudDetection.details,
      consecutive_count: consecutiveCount,
      escalated_severity: escalatedSeverity,
    }),
    notification: buildNotification(fraudDetection.type, escalatedSeverity),
    adminNotifyRequired,
    consecutiveCount,
  }
}

export async function resetFraudCount(userId: string): Promise<void> {
  await redis.del(buildFraudCountKey(userId))
}
