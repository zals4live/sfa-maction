import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, SUPER_ADMIN_ONLY } from '../../middleware/roleGuard'
import { withRLS } from '../../db'
import {
  CustomerSyncBody,
  MaterialSyncBody,
  PriceSyncBody,
  StockSyncBody,
  PromotionSyncBody,
  LeadSyncBody,
} from './schemas'
import {
  syncCustomers,
  syncMaterials,
  syncPrices,
  syncStock,
  syncPromotions,
  syncLeads,
  ServiceError,
} from './service'
import { writeInboundSyncAudit } from './audit'
import type { InboundSyncType } from './audit'
import type { Transaction } from '../../db'
import type { JWTClaims } from '../../middleware/tenantGuard'
import type { ErpSyncResult } from './schemas'

/**
 * ERP integration — inbound webhook routes.
 *
 * All endpoints are SUPER_ADMIN exclusive (cross-tenant governance per security
 * steering); the requireRole guard rejects every other role with 403. Each batch
 * is idempotent via its `idempotency_key` (Redis, 24h TTL) so redelivery is
 * at-most-once. Per-record upsert logic lives in the service layer and is applied
 * inside a withRLS transaction scoped to the caller's tenant.
 *
 * Every inbound sync operation — success OR failure — records one row in
 * `audit_erp_sync_logs` (Layer 3: ERP Sync Audit) via `writeInboundSyncAudit`,
 * written inside the same tenant-scoped transaction so it shares the RLS context
 * and commits atomically with the batch.
 *
 * On success each endpoint returns the `ErpSyncResultResponse` envelope (see
 * ./schemas). A no-strict `response` schema is intentionally omitted so the
 * ServiceError path can return the structured `{ error }` envelope (matching the
 * error-mapping convention used across sibling route modules).
 */
export const erpSyncRoutes = new Elysia({ prefix: '/erp' })
  .use(tenantGuard)
  .use(requireRole(...SUPER_ADMIN_ONLY))
  .post(
    '/webhook/customers',
    ({ body, claims, set }) =>
      runWebhook(claims!, set, 'CUSTOMER_SYNC', '/erp/webhook/customers', body, (tx, companyId) =>
        syncCustomers(tx, companyId, body)
      ),
    { body: CustomerSyncBody }
  )
  .post(
    '/webhook/materials',
    ({ body, claims, set }) =>
      runWebhook(claims!, set, 'MATERIAL_SYNC', '/erp/webhook/materials', body, (tx, companyId) =>
        syncMaterials(tx, companyId, body)
      ),
    { body: MaterialSyncBody }
  )
  .post(
    '/webhook/prices',
    ({ body, claims, set }) =>
      runWebhook(claims!, set, 'PRICE_SYNC', '/erp/webhook/prices', body, (tx, companyId) =>
        syncPrices(tx, companyId, body)
      ),
    { body: PriceSyncBody }
  )
  .post(
    '/webhook/stock',
    ({ body, claims, set }) =>
      runWebhook(claims!, set, 'STOCK_SYNC', '/erp/webhook/stock', body, (tx, companyId) =>
        syncStock(tx, companyId, body)
      ),
    { body: StockSyncBody }
  )
  .post(
    '/webhook/promotions',
    ({ body, claims, set }) =>
      runWebhook(claims!, set, 'PROMOTION_SYNC', '/erp/webhook/promotions', body, (tx, companyId) =>
        syncPromotions(tx, companyId, body)
      ),
    { body: PromotionSyncBody }
  )
  .post(
    '/webhook/leads',
    ({ body, claims, set }) =>
      runWebhook(claims!, set, 'LEAD_SYNC', '/erp/webhook/leads', body, (tx, companyId) =>
        syncLeads(tx, companyId, body)
      ),
    { body: LeadSyncBody }
  )

/** Elysia `set` shape used for status mapping (minimal to avoid importing internals). */
interface ResponseSet {
  status?: number | string
}

/** Structured error envelope returned to the caller on a mapped ServiceError. */
interface ErrorEnvelope {
  error: { code: string; message: string }
}

/**
 * Extracts the batch `idempotency_key` (uuid) from an inbound body for the audit
 * row. Returns null when the field is absent/non-string so the audit write never
 * throws on a malformed payload.
 */
function extractIdempotencyKey(body: unknown): string | null {
  if (body != null && typeof body === 'object' && 'idempotency_key' in body) {
    const key = (body as { idempotency_key: unknown }).idempotency_key
    if (typeof key === 'string') return key
  }
  return null
}

/**
 * Shared webhook driver: runs a per-type sync handler inside a tenant-scoped RLS
 * transaction, records the ERP sync audit row (success or failure) within that
 * same transaction, and maps ServiceError to a structured error response.
 *
 * The ServiceError is caught INSIDE the transaction so the failure audit row is
 * committed alongside (rather than rolled back with) the aborted batch; the
 * caught error is then re-surfaced to `runWebhook` which sets the HTTP status.
 * Raw database errors are never surfaced — they propagate to Elysia's error hook.
 */
async function runWebhook(
  claims: JWTClaims,
  set: ResponseSet,
  syncType: InboundSyncType,
  endpointUrl: string,
  body: unknown,
  handler: (tx: Transaction, companyId: string) => Promise<ErpSyncResult>
): Promise<ErpSyncResult | ErrorEnvelope> {
  const idempotencyKey = extractIdempotencyKey(body)
  const startedAt = performance.now()

  const outcome = await withRLS(
    { companyId: claims.company_id, userId: claims.user_id, userRole: claims.role_label },
    (tx) => applyAndAudit(tx, claims.company_id, syncType, endpointUrl, body, idempotencyKey, startedAt, handler)
  )

  if (!outcome.ok) {
    set.status = outcome.status
    return { error: { code: outcome.code, message: outcome.message } }
  }
  return outcome.result
}

/** Discriminated result of a sync attempt: applied envelope or mapped failure. */
type WebhookOutcome =
  | { ok: true; result: ErpSyncResult }
  | { ok: false; status: number; code: string; message: string }

/**
 * Runs the sync handler and writes the audit row within the active transaction.
 * A ServiceError is captured and mapped to a structured failure outcome (audited
 * as isSuccess=false); any other error rethrows after best-effort audit so raw
 * DB errors still propagate to Elysia's error hook without a silent audit gap.
 */
async function applyAndAudit(
  tx: Transaction,
  companyId: string,
  syncType: InboundSyncType,
  endpointUrl: string,
  body: unknown,
  idempotencyKey: string | null,
  startedAt: number,
  handler: (tx: Transaction, companyId: string) => Promise<ErpSyncResult>
): Promise<WebhookOutcome> {
  try {
    const result = await handler(tx, companyId)
    await writeInboundSyncAudit(tx, {
      companyId,
      syncType,
      endpointUrl,
      idempotencyKey,
      requestPayload: body,
      latencyMs: elapsedMs(startedAt),
      isSuccess: true,
      result,
    })
    return { ok: true, result }
  } catch (err) {
    if (err instanceof ServiceError) {
      await writeInboundSyncAudit(tx, {
        companyId,
        syncType,
        endpointUrl,
        idempotencyKey,
        requestPayload: body,
        latencyMs: elapsedMs(startedAt),
        isSuccess: false,
        errorCode: err.code,
        errorMessage: err.message,
      })
      return { ok: false, status: err.status, code: err.code, message: err.message }
    }
    throw err
  }
}

/** Rounds elapsed wall-clock time since `startedAt` (performance.now) to whole ms. */
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
