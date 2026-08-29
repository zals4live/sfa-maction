import { and, eq, sql } from 'drizzle-orm'

import { withRLS, type RLSContext, type Transaction } from '../../db'
import { auditVisitLifecycle } from '../../db/schema/audit'

// =============================================================================
// Types
// =============================================================================

/**
 * Canonical lifecycle step names recorded in audit_visit_lifecycle.step_name.
 * The stream is shared by Salesman AND MR — the visit module is role-agnostic,
 * so every field role progresses through the same detailing/audit steps. Only
 * order-taking (Salesman-exclusive) lives outside this set.
 */
export const VisitLifecycleStep = {
  VISIT_IN: 'VISIT_IN',
  DETAILING: 'DETAILING',
  STOCK_AUDIT: 'STOCK_AUDIT',
  COMPETITOR_AUDIT: 'COMPETITOR_AUDIT',
  VISIT_OUT: 'VISIT_OUT',
} as const

/** String-literal union of the lifecycle step names. */
export type VisitLifecycleStepName =
  (typeof VisitLifecycleStep)[keyof typeof VisitLifecycleStep]

/** Optional GPS coordinates captured alongside a lifecycle step. */
export interface LifecycleCoordinates {
  latitude: number
  longitude: number
}

/**
 * A single lifecycle step to append to the visit's timestamp-progression
 * stream. Sequence and duration-from-previous are computed by the service —
 * callers never supply them.
 */
export interface LifecycleStepRecord {
  visitId: string
  stepName: VisitLifecycleStepName
  /** ISO timestamp of the step; defaults to now when omitted. */
  stepTimestamp?: string
  /** Optional GPS fix (visit-in / visit-out) persisted as a PostGIS point. */
  coordinates?: LifecycleCoordinates | null
  /** Optional structured metadata (distance, signature key, etc.). */
  metadata?: Record<string, unknown> | null
}

/**
 * Tenant + user context required to attribute a lifecycle step. Mirrors the
 * RLS context so the insert satisfies the tenant-isolation policy on
 * audit_visit_lifecycle (company_id = app.current_company_id).
 */
export interface LifecycleContext {
  companyId: string
  userId: string
  userRole: string
}

// =============================================================================
// Sequence + duration computation
// =============================================================================

/** Result of resolving the position of a new step in a visit's stream. */
interface StepProgression {
  stepSequence: number
  durationFromPrevMs: number | null
}

/**
 * Resolves the next monotonic sequence number and the elapsed milliseconds
 * since the previous step for a visit. The first step gets sequence 1 and a
 * null duration. Uses a parameterized query — no user input is concatenated.
 */
export async function resolveStepProgression(
  tx: Transaction,
  companyId: string,
  visitId: string,
  stepTimestamp: string
): Promise<StepProgression> {
  const [prev] = await tx
    .select({
      stepSequence: auditVisitLifecycle.stepSequence,
      stepTimestamp: auditVisitLifecycle.stepTimestamp,
    })
    .from(auditVisitLifecycle)
    .where(
      and(
        eq(auditVisitLifecycle.companyId, companyId),
        eq(auditVisitLifecycle.visitId, visitId)
      )
    )
    .orderBy(sql`${auditVisitLifecycle.stepSequence} DESC`)
    .limit(1)

  if (!prev) {
    return { stepSequence: 1, durationFromPrevMs: null }
  }

  const durationFromPrevMs =
    new Date(stepTimestamp).getTime() - new Date(prev.stepTimestamp).getTime()

  return { stepSequence: prev.stepSequence + 1, durationFromPrevMs }
}

// =============================================================================
// Row builder
// =============================================================================

/** Builds the PostGIS point expression for optional coordinates, or null. */
function buildGeomValue(
  coordinates: LifecycleCoordinates | null | undefined
): typeof auditVisitLifecycle.$inferInsert['geom'] {
  if (!coordinates) return null
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.longitude}, ${coordinates.latitude}), 4326)` as never
}

// =============================================================================
// Core write (uses an existing tx)
// =============================================================================

/**
 * Appends a lifecycle step to audit_visit_lifecycle using an existing RLS
 * transaction, so recording is atomic-ish with the primary visit operation.
 * Sequence and duration are derived from the visit's prior steps.
 *
 * @throws Propagates DB errors to the caller — recordLifecycleStep swallows them.
 */
export async function appendLifecycleStep(
  tx: Transaction,
  ctx: LifecycleContext,
  record: LifecycleStepRecord
): Promise<void> {
  const stepTimestamp = record.stepTimestamp ?? new Date().toISOString()

  const { stepSequence, durationFromPrevMs } = await resolveStepProgression(
    tx,
    ctx.companyId,
    record.visitId,
    stepTimestamp
  )

  await tx.insert(auditVisitLifecycle).values({
    companyId: ctx.companyId,
    visitId: record.visitId,
    userId: ctx.userId,
    stepName: record.stepName,
    stepTimestamp,
    stepSequence,
    durationFromPrevMs,
    geom: buildGeomValue(record.coordinates),
    metadata: record.metadata ?? null,
  })
}

/**
 * Standalone variant that opens its own RLS transaction. Use when a lifecycle
 * step must be recorded outside an existing visit-service transaction.
 *
 * @throws Propagates DB errors — recordLifecycleStep swallows them.
 */
export async function logLifecycleStep(
  ctx: LifecycleContext,
  record: LifecycleStepRecord
): Promise<void> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  await withRLS(rlsCtx, async (tx) => {
    await appendLifecycleStep(tx, ctx, record)
  })
}

// =============================================================================
// Best-effort wrapper (non-fatal)
// =============================================================================

/**
 * Logs a swallowed lifecycle-recording failure. Extracted so every non-fatal
 * path emits an identical structured line without leaking raw PG error objects.
 */
function logLifecycleFailure(record: LifecycleStepRecord, err: unknown): void {
  console.error(
    `[audit] failed to record visit lifecycle step ${record.stepName} for visit ${record.visitId}:`,
    err instanceof Error ? err.message : err
  )
}

/**
 * Best-effort recorder that reuses the caller's open transaction so the step is
 * written alongside the visit mutation (atomic-ish). A failure is logged but
 * MUST NOT throw out of the primary visit flow — the audit trail is
 * supplementary, never a blocker.
 *
 * NOTE: because a failed statement aborts the surrounding Postgres transaction,
 * this variant is only non-fatal for the CALLER (it never rethrows); prefer
 * {@link recordLifecycleStepAfterCommit} when the primary op must be guaranteed
 * durable regardless of audit outcome.
 */
export async function recordLifecycleStep(
  tx: Transaction,
  ctx: LifecycleContext,
  record: LifecycleStepRecord
): Promise<void> {
  try {
    await appendLifecycleStep(tx, ctx, record)
  } catch (err) {
    logLifecycleFailure(record, err)
  }
}

/**
 * Best-effort recorder that opens its OWN transaction after the primary visit
 * operation has committed. Guarantees the visit mutation is durable even if the
 * audit insert fails. A failure is logged and swallowed — never rethrown.
 */
export async function recordLifecycleStepAfterCommit(
  ctx: LifecycleContext,
  record: LifecycleStepRecord
): Promise<void> {
  try {
    await logLifecycleStep(ctx, record)
  } catch (err) {
    logLifecycleFailure(record, err)
  }
}
