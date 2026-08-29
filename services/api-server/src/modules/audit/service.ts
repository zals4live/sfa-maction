import { withRLS, type RLSContext } from '../../db'
import { auditMutationLogs } from '../../db/schema/audit'

// --- Types ---

/** Mutation action types recorded in audit_mutation_logs.action_type. */
export type AuditActionType = 'INSERT' | 'UPDATE' | 'DELETE'

/**
 * A single mutation to be recorded in the Layer 1 application audit trail.
 * Captures the affected entity, its primary key, the action, and before/after
 * JSON snapshots for forensic delta review.
 */
export interface MutationRecord {
  entityName: string
  recordId: string
  actionType: AuditActionType
  /** Prior state — omit/null for INSERT. */
  beforeSnapshot?: Record<string, unknown> | null
  /** New state — omit/null for DELETE. */
  afterSnapshot?: Record<string, unknown> | null
}

/**
 * Tenant + request context required to attribute a mutation to a user.
 * Mirrors the RLS context so the write passes the FORCE ROW LEVEL SECURITY
 * WITH CHECK (company_id = app.current_company_id) policy.
 */
export interface AuditContext {
  companyId: string
  userId: string
  userRole: string
  clientIp?: string | null
  userAgent?: string | null
}

// --- Snapshot rules per action type ---

/**
 * Normalizes before/after snapshots to match the DB semantics:
 *   INSERT → beforeSnapshot is always NULL
 *   DELETE → afterSnapshot is always NULL
 *   UPDATE → both retained as provided
 */
function normalizeSnapshots(mutation: MutationRecord): {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
} {
  switch (mutation.actionType) {
    case 'INSERT':
      return { before: null, after: mutation.afterSnapshot ?? null }
    case 'DELETE':
      return { before: mutation.beforeSnapshot ?? null, after: null }
    case 'UPDATE':
    default:
      return {
        before: mutation.beforeSnapshot ?? null,
        after: mutation.afterSnapshot ?? null,
      }
  }
}

// --- Core logging ---

/**
 * Persists one or more mutation records to audit_mutation_logs within a single
 * RLS-scoped transaction. Writes flow through withRLS so the tenant session
 * variables required by the FORCE RLS policy are set.
 *
 * @throws Propagates DB errors to the caller — the interceptor swallows them.
 */
export async function logMutations(
  ctx: AuditContext,
  mutations: MutationRecord[]
): Promise<void> {
  if (mutations.length === 0) return

  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const rows = mutations.map((mutation) => {
    const { before, after } = normalizeSnapshots(mutation)
    return {
      companyId: ctx.companyId,
      userId: ctx.userId,
      entityName: mutation.entityName,
      recordId: mutation.recordId,
      actionType: mutation.actionType,
      beforeSnapshot: before,
      afterSnapshot: after,
      clientIp: ctx.clientIp ?? null,
      userAgent: ctx.userAgent ?? null,
    }
  })

  await withRLS(rlsCtx, async (tx) => {
    await tx.insert(auditMutationLogs).values(rows)
  })
}

/**
 * Fire-and-forget wrapper around logMutations. Audit logging must never block
 * or fail the primary request, so DB errors are swallowed intentionally.
 */
export function recordMutations(
  ctx: AuditContext,
  mutations: MutationRecord[]
): void {
  logMutations(ctx, mutations).catch(() => {
    // Non-blocking: audit trail failures must not break the primary operation.
  })
}
