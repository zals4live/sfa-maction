import { eq, and, gte, lte, desc, count, type SQL } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { auditFraudTelemetry } from '../../db/schema/audit'
import type { FraudIncidentParams, FraudIncidentResponseType } from './schemas'

/**
 * Fraud incident report query from `audit_fraud_telemetry` (FR-AUD fraud
 * review). Powers the ADMIN-only `GET /reports/fraud-incidents` register.
 *
 * Tenant isolation is enforced twice: the query filters on
 * `company_id = ctx.companyId` AND runs inside the RLS-scoped transaction
 * (`app.current_company_id` session var). Optional filters narrow by user,
 * fraud type, and an inclusive `created_at` date range. Results are paginated
 * (LIMIT/OFFSET) and ordered newest-first with a stable tiebreak on `id`.
 *
 * Response field names are snake_case (`FraudIncidentRowSchema`) and differ
 * from the camelCase Drizzle columns; nullable `severity` / `action_taken`
 * columns are coalesced to their DB defaults so the string-typed response
 * schema always receives a value.
 */

/** Default DB value for a nullable severity column. */
const DEFAULT_SEVERITY = 'LOW'

/** Default DB value for a nullable action_taken column. */
const DEFAULT_ACTION_TAKEN = 'SOFT_REJECT'

/** A single fraud incident row (matches FraudIncidentRowSchema). */
type FraudIncidentRow = FraudIncidentResponseType['data'][number]

/** Minimal DB projection needed to build a fraud incident row. */
export interface FraudTelemetryRecord {
  id: string
  userId: string
  fraudType: FraudIncidentRow['fraud_type']
  severity: string | null
  claimedLat: number | null
  claimedLng: number | null
  calculatedSpeedKmh: number | null
  actionTaken: string | null
  createdAt: string | null
}

/**
 * Builds the WHERE conditions for the fraud incident query. Always scopes to
 * the tenant; optional filters narrow by user, fraud type, and date range.
 */
export function buildFraudConditions(params: FraudIncidentParams, companyId: string): SQL[] {
  const conditions: SQL[] = [eq(auditFraudTelemetry.companyId, companyId)]

  if (params.user_id) conditions.push(eq(auditFraudTelemetry.userId, params.user_id))
  if (params.fraud_type) conditions.push(eq(auditFraudTelemetry.fraudType, params.fraud_type))
  if (params.date_from) conditions.push(gte(auditFraudTelemetry.createdAt, params.date_from))
  if (params.date_to) conditions.push(lte(auditFraudTelemetry.createdAt, params.date_to))

  return conditions
}

/** Resolves the effective page/limit and derived LIMIT/OFFSET for pagination. */
export function resolvePagination(params: FraudIncidentParams): {
  page: number
  limit: number
  offset: number
} {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  return { page, limit, offset: (page - 1) * limit }
}

/** Maps a raw telemetry record to the response row shape. */
export function mapFraudRow(record: FraudTelemetryRecord): FraudIncidentRow {
  return {
    id: record.id,
    user_id: record.userId,
    fraud_type: record.fraudType,
    severity: record.severity ?? DEFAULT_SEVERITY,
    claimed_lat: record.claimedLat,
    claimed_lng: record.claimedLng,
    calculated_speed_kmh: record.calculatedSpeedKmh,
    action_taken: record.actionTaken ?? DEFAULT_ACTION_TAKEN,
    created_at: toIsoString(record.createdAt),
  }
}

/** Normalizes a DB timestamp (string) to an ISO date-time string. */
function toIsoString(value: string | null): string {
  if (!value) return new Date(0).toISOString()
  return new Date(value).toISOString()
}

/** Fetches the total count of matching incidents (for pagination meta). */
export async function fetchFraudTotal(
  tx: Transaction,
  conditions: SQL[]
): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(auditFraudTelemetry)
    .where(and(...conditions))

  return row?.total ?? 0
}

/** Fetches a page of matching incidents, newest-first with a stable tiebreak. */
export async function fetchFraudPage(
  tx: Transaction,
  conditions: SQL[],
  limit: number,
  offset: number
): Promise<FraudIncidentRow[]> {
  const rows = await tx
    .select({
      id: auditFraudTelemetry.id,
      userId: auditFraudTelemetry.userId,
      fraudType: auditFraudTelemetry.fraudType,
      severity: auditFraudTelemetry.severity,
      claimedLat: auditFraudTelemetry.claimedLat,
      claimedLng: auditFraudTelemetry.claimedLng,
      calculatedSpeedKmh: auditFraudTelemetry.calculatedSpeedKmh,
      actionTaken: auditFraudTelemetry.actionTaken,
      createdAt: auditFraudTelemetry.createdAt,
    })
    .from(auditFraudTelemetry)
    .where(and(...conditions))
    .orderBy(desc(auditFraudTelemetry.createdAt), desc(auditFraudTelemetry.id))
    .limit(limit)
    .offset(offset)

  return rows.map(mapFraudRow)
}
