import { Elysia } from 'elysia'

import {
  recordMutations,
  type AuditActionType,
  type AuditContext,
  type MutationRecord,
} from '../modules/audit/service'
import type { JWTClaims } from './tenantGuard'

// --- Constants ---

/** HTTP methods that represent mutations and are eligible for audit logging. */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Maps an HTTP method to its default audit action type. */
const METHOD_ACTION: Record<string, AuditActionType> = {
  POST: 'INSERT',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
}

// --- Types ---

/**
 * Details a handler provides when registering a mutation for the audit trail.
 * The action type is optional — it defaults to one derived from the HTTP method
 * (POST→INSERT, PUT/PATCH→UPDATE, DELETE→DELETE).
 */
export interface AuditMutationInput {
  entityName: string
  recordId: string
  actionType?: AuditActionType
  beforeSnapshot?: Record<string, unknown> | null
  afterSnapshot?: Record<string, unknown> | null
}

/** Collector attached to request context for handlers to register mutations. */
export interface AuditCollector {
  (input: AuditMutationInput): void
}

// --- Helpers ---

/** Derives the best-effort originating client IP from proxy headers. */
export function resolveClientIp(headers: Record<string, string | undefined>): string | null {
  const forwarded = headers['x-forwarded-for']?.split(',')[0]?.trim()
  return forwarded || headers['x-real-ip'] || null
}

/** Whether a completed request should be considered a successful mutation. */
export function isSuccessfulMutation(method: string, status: number): boolean {
  if (!MUTATION_METHODS.has(method.toUpperCase())) return false
  return status >= 200 && status < 300
}

/** Resolves the numeric HTTP status from Elysia's `set.status` shape. */
function resolveStatus(status: number | string | undefined): number {
  if (typeof status === 'number') return status
  return 200
}

// --- Elysia Plugin ---

/**
 * Audit interceptor Elysia plugin (Layer 1 — Application Mutation Logs).
 *
 * Derives an `audit` collector into the request context. Mutation route handlers
 * call `audit({ entityName, recordId, before, after })` to register a change.
 * After the handler completes successfully (2xx on a mutating HTTP method), the
 * buffered mutations are flushed to `audit_mutation_logs` — capturing user_id,
 * company_id, client_ip, and user_agent from the JWT claims and request headers.
 *
 * Writes are fire-and-forget and RLS-scoped, so audit failures never break the
 * primary request. Must be applied AFTER tenantGuard so `claims` is available.
 */
export const auditInterceptor = new Elysia({ name: 'auditInterceptor' })
  .derive(() => {
    const buffer: MutationRecord[] = []

    const audit: AuditCollector = (input) => {
      buffer.push({
        entityName: input.entityName,
        recordId: input.recordId,
        actionType: input.actionType ?? 'UPDATE',
        beforeSnapshot: input.beforeSnapshot ?? null,
        afterSnapshot: input.afterSnapshot ?? null,
      })
    }

    return { audit, auditBuffer: buffer }
  })
  .onAfterHandle((rawCtx) => {
    const ctx = rawCtx as unknown as {
      request: Request
      headers: Record<string, string | undefined>
      set: { status?: number | string }
      claims: JWTClaims | null
      auditBuffer: MutationRecord[]
    }

    const claims = ctx.claims
    const buffer = ctx.auditBuffer
    if (!claims || !buffer || buffer.length === 0) return

    const method = ctx.request.method
    const status = resolveStatus(ctx.set.status)
    if (!isSuccessfulMutation(method, status)) return

    // Default any unset action types from the HTTP method.
    const defaultAction = METHOD_ACTION[method.toUpperCase()] ?? 'UPDATE'
    const mutations: MutationRecord[] = buffer.map((m) => ({
      ...m,
      actionType: m.actionType ?? defaultAction,
    }))

    const auditCtx: AuditContext = {
      companyId: claims.company_id,
      userId: claims.user_id,
      userRole: claims.role_label,
      clientIp: resolveClientIp(ctx.headers),
      userAgent: ctx.headers['user-agent'] ?? null,
    }

    recordMutations(auditCtx, mutations)
  })
  .as('scoped')
