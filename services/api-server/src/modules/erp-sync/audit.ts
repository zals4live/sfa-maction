import { auditErpSyncLogs } from '../../db/schema/audit'
import type { Transaction } from '../../db'
import type { ErpSyncResult } from './schemas'

// =============================================================================
// Inbound ERP sync audit logging (Layer 3: ERP Sync Audit).
//
// Records one row in `audit_erp_sync_logs` for every inbound webhook sync
// operation — success OR failure. The outbound order → quotation worker owns
// its own audit write (queues/erpSyncWorker.ts::writeSyncAudit); this module is
// the inbound counterpart so BOTH directions of every ERP sync are captured.
//
// The write MUST run inside the same tenant-scoped RLS transaction that applied
// the sync, because `audit_erp_sync_logs.company_id` is RLS-enforced. Callers
// therefore pass the active Drizzle transaction (`tx`).
//
// Per security steering, the row captures: sync direction (INBOUND), sync type,
// endpoint URL, request/response payloads, HTTP status, latency, retry count,
// idempotency key, and structured success/error fields. Raw PostgreSQL errors
// are never persisted here — callers map failures to structured codes/messages.
// =============================================================================

/** Inbound webhook sync types — one per ERP webhook endpoint. */
export type InboundSyncType =
  | 'CUSTOMER_SYNC'
  | 'MATERIAL_SYNC'
  | 'PRICE_SYNC'
  | 'STOCK_SYNC'
  | 'PROMOTION_SYNC'
  | 'LEAD_SYNC'

/** The related entity table each inbound sync type primarily writes into. */
const RELATED_ENTITY: Record<InboundSyncType, string> = {
  CUSTOMER_SYNC: 'master_customer',
  MATERIAL_SYNC: 'master_material',
  PRICE_SYNC: 'master_price',
  STOCK_SYNC: 'stock_inventory_atp',
  PROMOTION_SYNC: 'master_promotions',
  LEAD_SYNC: 'visit_plans',
}

/** Parameters captured for a single inbound ERP sync audit log row. */
export interface InboundAuditParams {
  companyId: string
  syncType: InboundSyncType
  /** The webhook endpoint that received the batch (e.g. `/erp/webhook/customers`). */
  endpointUrl: string
  /** Idempotency key from the request body (uuid), or null when unparsable. */
  idempotencyKey: string | null
  /** The raw inbound request payload (batch envelope). */
  requestPayload: unknown
  /** Wall-clock elapsed time for the sync handler, in milliseconds. */
  latencyMs: number
  /** True when the batch applied without a structural (ServiceError) failure. */
  isSuccess: boolean
  /** Structured sync result envelope when the batch was applied, else null. */
  result?: ErpSyncResult | null
  /** Structured error code when the batch failed (never a raw PG error). */
  errorCode?: string | null
  /** Human-readable error message when the batch failed. */
  errorMessage?: string | null
}

/**
 * Writes one `audit_erp_sync_logs` row for an inbound webhook sync operation.
 *
 * On success `responsePayload` stores the structured sync envelope (received /
 * created / updated / failed counts + per-record errors) so partial failures
 * remain auditable. On failure it stores the structured error code + message.
 * Must be invoked inside the tenant-scoped RLS transaction (`tx`).
 */
export async function writeInboundSyncAudit(
  tx: Transaction,
  params: InboundAuditParams
): Promise<void> {
  await tx.insert(auditErpSyncLogs).values({
    companyId: params.companyId,
    syncDirection: 'INBOUND',
    syncType: params.syncType,
    endpointUrl: params.endpointUrl,
    httpMethod: 'POST',
    requestPayload: toJsonb(params.requestPayload),
    responsePayload: params.result ? toJsonb(params.result) : null,
    // Inbound webhooks respond 200 on a successfully applied batch, 400/409/…
    // when a ServiceError is mapped by the route. We only reliably know the
    // success/failure split here; store 200 on success and leave null on
    // failure (the structured errorCode carries the real cause).
    httpStatusCode: params.isSuccess ? 200 : null,
    latencyMs: params.latencyMs,
    // Inbound batches are not retried by this server (the ERP is the retrier),
    // so retryCount stays at its default of 0 for inbound rows.
    retryCount: 0,
    idempotencyKey: params.idempotencyKey,
    isSuccess: params.isSuccess,
    errorMessage: params.errorMessage ?? null,
    errorCode: params.errorCode ?? null,
    relatedEntity: RELATED_ENTITY[params.syncType],
    relatedRecordId: null,
    bullmqJobId: null,
  })
}

/**
 * Narrows an arbitrary value to a JSONB-serializable object for the audit
 * column. The audit table's payload columns are `jsonb`; scalars/arrays are
 * wrapped so Drizzle always receives an object shape it can serialize safely.
 */
function toJsonb(value: unknown): Record<string, unknown> | null {
  if (value == null) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return { value } as Record<string, unknown>
}
