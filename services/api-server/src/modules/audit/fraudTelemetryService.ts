import type { FraudType } from '@maction/types'
import { withRLS, type RLSContext } from '../../db'
import { auditFraudTelemetry } from '../../db/schema/audit'

// --- Types ---

/**
 * Accepted fraud type value — the string-literal union of the shared FraudType
 * enum. Accepts both `FraudType` enum members and their literal string values,
 * matching the fraud_type_enum PostgreSQL definition.
 */
export type FraudTypeValue = `${FraudType}`

/** Fraud incident severity — mirrors audit_fraud_telemetry.severity. */
export type FraudSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

/**
 * Structured telemetry payload for a single detected fraud incident.
 * Field names map to the audit_fraud_telemetry Drizzle columns. Optional
 * fields default to NULL so partial detections (e.g. accuracy-only) still
 * produce a complete, forensic-grade record.
 */
export interface FraudTelemetryRecord {
  fraudType: FraudTypeValue
  severity?: FraudSeverity
  claimedLat?: number | null
  claimedLng?: number | null
  claimedAccuracyMeters?: number | null
  calculatedSpeedKmh?: number | null
  distanceFromTargetMeters?: number | null
  clientTimestamp?: string | null
  monoDeltaMs?: number | null
  clockDriftSeconds?: number | null
  deviceInfo?: Record<string, unknown> | null
  isMockProvider?: boolean
  rawPayload?: Record<string, unknown> | null
  requestEndpoint?: string | null
  actionTaken?: string
}

/**
 * Tenant + request context required to attribute a fraud incident to a user.
 * Mirrors the RLS context so the insert satisfies the tenant-isolation policy
 * on audit_fraud_telemetry (company_id = app.current_company_id).
 */
export interface FraudTelemetryContext {
  companyId: string
  userId: string
  userRole: string
  clientIp?: string | null
}

// --- Row builder ---

/**
 * Maps a structured telemetry record + context to the Drizzle insert shape,
 * coalescing every optional field to its NULL/default counterpart.
 */
function buildTelemetryRow(
  ctx: FraudTelemetryContext,
  record: FraudTelemetryRecord
): typeof auditFraudTelemetry.$inferInsert {
  return {
    companyId: ctx.companyId,
    userId: ctx.userId,
    fraudType: record.fraudType,
    severity: record.severity ?? 'LOW',
    claimedLat: record.claimedLat ?? null,
    claimedLng: record.claimedLng ?? null,
    claimedAccuracyMeters: record.claimedAccuracyMeters ?? null,
    calculatedSpeedKmh: record.calculatedSpeedKmh ?? null,
    distanceFromTargetMeters: record.distanceFromTargetMeters ?? null,
    clientTimestamp: record.clientTimestamp ?? null,
    monoDeltaMs: record.monoDeltaMs ?? null,
    clockDriftSeconds: record.clockDriftSeconds ?? null,
    deviceInfo: record.deviceInfo ?? null,
    isMockProvider: record.isMockProvider ?? false,
    rawPayload: record.rawPayload ?? null,
    requestEndpoint: record.requestEndpoint ?? null,
    clientIp: ctx.clientIp ?? null,
    actionTaken: record.actionTaken ?? 'SOFT_REJECT',
  }
}

// --- Core write ---

/**
 * Persists a single fraud incident to audit_fraud_telemetry within an
 * RLS-scoped transaction so the tenant session variables required by the
 * isolation policy are set. Uses parameterized Drizzle query building —
 * no user input is ever concatenated into SQL.
 *
 * @throws Propagates DB errors to the caller — recordFraudTelemetry swallows them.
 */
export async function logFraudTelemetry(
  ctx: FraudTelemetryContext,
  record: FraudTelemetryRecord
): Promise<void> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const row = buildTelemetryRow(ctx, record)

  await withRLS(rlsCtx, async (tx) => {
    await tx.insert(auditFraudTelemetry).values(row)
  })
}

/**
 * Fire-and-forget wrapper around logFraudTelemetry. Telemetry logging must
 * never block or fail the primary request (soft-rejection flow), so DB errors
 * are swallowed intentionally.
 */
export function recordFraudTelemetry(
  ctx: FraudTelemetryContext,
  record: FraudTelemetryRecord
): void {
  logFraudTelemetry(ctx, record).catch(() => {
    // Non-blocking: fraud telemetry failures must not break the primary operation.
  })
}
