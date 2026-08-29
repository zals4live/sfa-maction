import { Queue, Worker } from 'bullmq'
import type { Job, JobsOptions } from 'bullmq'
import { and, eq, sql } from 'drizzle-orm'

import { createRedisConnection } from '../config/redis'
import { withRLS } from '../db'
import {
  claimIdempotencyKey,
  generateIdempotencyKey,
} from '../modules/erp-sync/idempotency'
import type { RLSContext, Transaction } from '../db'
import { orders, orderItems } from '../db/schema/order'
import { companies } from '../db/schema/tenant'
import { auditErpSyncLogs } from '../db/schema/audit'

// =============================================================================
// Outbound ERP Sales Quotation worker.
//
// Consumes the `erp-order-sync` queue. Each job resolves a SUBMITTED order and
// its line items (RLS-scoped to the tenant), builds an ERP Sales Quotation
// payload, POSTs it to the tenant's ERP endpoint with an `idempotency_key`, and
// records the outcome. On success the order moves to SYNCED_ERP; only after the
// final retry attempt is exhausted does a failure mark it REJECTED_ERP. Every
// attempt — success or failure — is written to `audit_erp_sync_logs`.
//
// Idempotency key generation + Redis duplicate detection are provided by the
// shared `modules/erp-sync/idempotency` layer. Outbound claims use the 'order'
// scope so they never collide with inbound webhook scopes.
// =============================================================================

/** BullMQ queue name for outbound order → ERP quotation sync jobs. */
export const ERP_ORDER_SYNC_QUEUE = 'erp-order-sync'

/** System RLS actor for background jobs (no interactive user). Uses the nil UUID. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'

/** Role granting full tenant material/order access for the background actor. */
const SYSTEM_USER_ROLE = 'SUPER_ADMIN'

/** Idempotency scope for outbound order → quotation claims (never collides with inbound). */
const OUTBOUND_IDEMPOTENCY_SCOPE = 'order'

/**
 * TTL for outbound idempotency keys: 24 hours (seconds). Re-exported from the
 * shared idempotency layer to preserve the historical export surface.
 */
export { IDEMPOTENCY_TTL_SECONDS as OUTBOUND_IDEMPOTENCY_TTL_SECONDS } from '../modules/erp-sync/idempotency'

/** Retry attempts before an order is finally marked REJECTED_ERP. */
export const ERP_SYNC_MAX_ATTEMPTS = 5

/** Base delay (ms) for the exponential backoff schedule. */
export const ERP_SYNC_BACKOFF_DELAY_MS = 5_000

/** Default per-job options: exponential backoff + bounded attempts. */
export const ERP_SYNC_JOB_OPTIONS: JobsOptions = {
  attempts: ERP_SYNC_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: ERP_SYNC_BACKOFF_DELAY_MS },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
}

/** Job payload enqueued when an order is submitted for ERP sync. */
export interface ErpOrderSyncJobData {
  orderId: string
  companyId: string
  idempotencyKey: string
}

/** Line item shape included in the outbound ERP quotation payload. */
export interface ErpQuotationLine {
  material_id: string
  qty: number
  uom: string
  unit_price: string
  discount_amount: string
  subtotal: string
}

/** Outbound ERP Sales Quotation request payload. */
export interface ErpQuotationPayload {
  idempotency_key: string
  erp_company_code: string | null
  order_number: string
  order_date: string
  customer_id: string
  subtotal_amount: string
  total_discount_amount: string
  tax_amount: string
  grand_total: string
  lines: ErpQuotationLine[]
}

/** Tenant ERP endpoint + auth config resolved from the companies row. */
export interface ErpEndpointConfig {
  endpointUrl: string
  companyCode: string | null
  authConfig: Record<string, unknown> | null
}

/** Normalized result of the outbound HTTP call to the ERP gateway. */
interface ErpHttpResult {
  ok: boolean
  httpStatus: number | null
  responsePayload: Record<string, unknown> | null
  quotationNumber: string | null
  latencyMs: number
  errorCode: string | null
  errorMessage: string | null
}

// -----------------------------------------------------------------------------
// Queue + enqueue surface
// -----------------------------------------------------------------------------

let queueSingleton: Queue<ErpOrderSyncJobData> | null = null

/** Lazily constructs the shared outbound ERP sync Queue on an isolated connection. */
export function getErpOrderSyncQueue(): Queue<ErpOrderSyncJobData> {
  if (!queueSingleton) {
    queueSingleton = new Queue<ErpOrderSyncJobData>(ERP_ORDER_SYNC_QUEUE, {
      connection: createRedisConnection(),
      defaultJobOptions: ERP_SYNC_JOB_OPTIONS,
    })
  }
  return queueSingleton
}

/**
 * Enqueues an outbound ERP sync job for a submitted order. Generates the
 * idempotency key here so the same key rides every retry (at-most-once ERP
 * delivery). Callable from `POST /orders/:id/submit`.
 */
export async function enqueueOrderSync(
  orderId: string,
  companyId: string,
  idempotencyKey: string = generateIdempotencyKey()
): Promise<string> {
  const job = await getErpOrderSyncQueue().add(
    'sync-order',
    { orderId, companyId, idempotencyKey },
    { jobId: idempotencyKey }
  )
  return job.id ?? idempotencyKey
}

// -----------------------------------------------------------------------------
// Data resolution + payload building
// -----------------------------------------------------------------------------

/** Order header fields needed to build the outbound quotation payload. */
export interface OrderHeaderRow {
  orderNumber: string
  orderDate: string
  customerId: string
  orderStatus: string | null
  subtotalAmount: string
  totalDiscountAmount: string | null
  taxAmount: string
  grandTotal: string
}

/** Resolves the tenant ERP endpoint config; throws when the endpoint is unset. */
async function resolveErpConfig(tx: Transaction, companyId: string): Promise<ErpEndpointConfig> {
  const [row] = await tx
    .select({
      endpointUrl: companies.erpEndpointUrl,
      companyCode: companies.erpCompanyCode,
      authConfig: companies.erpAuthConfig,
    })
    .from(companies)
    .where(eq(companies.id, companyId))

  if (!row?.endpointUrl) {
    throw new ErpSyncError('ERP_ENDPOINT_NOT_CONFIGURED', 'Tenant has no configured ERP endpoint URL')
  }
  return {
    endpointUrl: row.endpointUrl,
    companyCode: row.companyCode ?? null,
    authConfig: (row.authConfig as Record<string, unknown> | null) ?? null,
  }
}

/** Fetches the order header, ensuring it exists and is in SUBMITTED status. */
async function fetchSubmittedOrder(tx: Transaction, orderId: string): Promise<OrderHeaderRow> {
  const [row] = await tx
    .select({
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      customerId: orders.customerId,
      orderStatus: orders.orderStatus,
      subtotalAmount: orders.subtotalAmount,
      totalDiscountAmount: orders.totalDiscountAmount,
      taxAmount: orders.taxAmount,
      grandTotal: orders.grandTotal,
    })
    .from(orders)
    .where(eq(orders.id, orderId))

  if (!row) throw new ErpSyncError('ORDER_NOT_FOUND', 'Order not found for ERP sync')
  if (row.orderStatus !== 'SUBMITTED' && row.orderStatus !== 'REJECTED_ERP') {
    throw new ErpSyncError(
      'ORDER_NOT_SYNCABLE',
      `Only SUBMITTED orders can be synced (current status: ${row.orderStatus})`
    )
  }
  return row
}

/** Fetches the order's line items for the quotation payload. */
async function fetchQuotationLines(tx: Transaction, orderId: string): Promise<ErpQuotationLine[]> {
  const rows = await tx
    .select({
      materialId: orderItems.materialId,
      qty: orderItems.qty,
      uom: orderItems.uom,
      unitPrice: orderItems.unitPrice,
      discountAmount: orderItems.discountAmount,
      subtotal: orderItems.subtotal,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))

  return rows.map((r) => ({
    material_id: r.materialId,
    qty: r.qty,
    uom: r.uom,
    unit_price: r.unitPrice,
    discount_amount: r.discountAmount ?? '0',
    subtotal: r.subtotal,
  }))
}

/** Assembles the outbound ERP Sales Quotation payload from resolved rows. */
export function buildQuotationPayload(
  header: OrderHeaderRow,
  lines: ErpQuotationLine[],
  config: ErpEndpointConfig,
  idempotencyKey: string
): ErpQuotationPayload {
  return {
    idempotency_key: idempotencyKey,
    erp_company_code: config.companyCode,
    order_number: header.orderNumber,
    order_date: header.orderDate,
    customer_id: header.customerId,
    subtotal_amount: header.subtotalAmount,
    total_discount_amount: header.totalDiscountAmount ?? '0',
    tax_amount: header.taxAmount,
    grand_total: header.grandTotal,
    lines,
  }
}

// -----------------------------------------------------------------------------
// ERP HTTP call
// -----------------------------------------------------------------------------

/** Builds request headers, injecting bearer auth from config by key name only. */
function buildErpHeaders(config: ErpEndpointConfig, idempotencyKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  }
  const token = config.authConfig?.['access_token']
  if (typeof token === 'string' && token.length > 0) {
    headers['authorization'] = `Bearer ${token}`
  }
  return headers
}

/** Extracts an ERP quotation number from a response body across common shapes. */
function extractQuotationNumber(body: Record<string, unknown> | null): string | null {
  if (!body) return null
  const candidate = body['quotation_number'] ?? body['erp_quotation_number'] ?? body['id']
  return typeof candidate === 'string' ? candidate : null
}

/**
 * POSTs the quotation payload to the tenant ERP gateway and normalizes the
 * outcome. Network/parse errors are captured (never rethrown) so the caller can
 * log the attempt and decide on retry vs final rejection.
 */
async function postToErp(
  config: ErpEndpointConfig,
  payload: ErpQuotationPayload
): Promise<ErpHttpResult> {
  const startedAt = performance.now()
  try {
    const response = await fetch(config.endpointUrl, {
      method: 'POST',
      headers: buildErpHeaders(config, payload.idempotency_key),
      body: JSON.stringify(payload),
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const body = await safeParseJson(response)
    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        responsePayload: body,
        quotationNumber: null,
        latencyMs,
        errorCode: `ERP_HTTP_${response.status}`,
        errorMessage: `ERP gateway returned HTTP ${response.status}`,
      }
    }
    return {
      ok: true,
      httpStatus: response.status,
      responsePayload: body,
      quotationNumber: extractQuotationNumber(body),
      latencyMs,
      errorCode: null,
      errorMessage: null,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      httpStatus: null,
      responsePayload: null,
      quotationNumber: null,
      latencyMs: Math.round(performance.now() - startedAt),
      errorCode: 'ERP_REQUEST_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Unknown ERP request failure',
    }
  }
}

/** Parses a JSON response body, returning null on empty/invalid bodies. */
async function safeParseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text()
    if (!text) return null
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// Status transitions + audit logging
// -----------------------------------------------------------------------------

/** Marks an order SYNCED_ERP with the returned quotation number + timestamp. */
async function markOrderSynced(
  tx: Transaction,
  orderId: string,
  companyId: string,
  quotationNumber: string | null
): Promise<void> {
  await tx
    .update(orders)
    .set({
      orderStatus: 'SYNCED_ERP',
      erpQuotationNumber: quotationNumber,
      erpSyncTimestamp: sql`NOW()`,
      erpErrorPayload: null,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(orders.id, orderId), eq(orders.companyId, companyId)))
}

/** Marks an order REJECTED_ERP and stores a sanitized error payload. */
async function markOrderRejected(
  tx: Transaction,
  orderId: string,
  companyId: string,
  result: ErpHttpResult
): Promise<void> {
  await tx
    .update(orders)
    .set({
      orderStatus: 'REJECTED_ERP',
      erpErrorPayload: {
        error_code: result.errorCode,
        error_message: result.errorMessage,
        http_status: result.httpStatus,
      },
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(orders.id, orderId), eq(orders.companyId, companyId)))
}

/** Parameters captured for a single ERP sync audit log row. */
interface AuditParams {
  companyId: string
  endpointUrl: string
  idempotencyKey: string
  requestPayload: ErpQuotationPayload
  result: ErpHttpResult
  retryCount: number
  orderId: string
  jobId: string | undefined
}

/** Writes one row to `audit_erp_sync_logs` for the attempt (success or failure). */
async function writeSyncAudit(tx: Transaction, params: AuditParams): Promise<void> {
  await tx.insert(auditErpSyncLogs).values({
    companyId: params.companyId,
    syncDirection: 'OUTBOUND',
    syncType: 'ORDER_QUOTATION',
    endpointUrl: params.endpointUrl,
    httpMethod: 'POST',
    requestPayload: params.requestPayload,
    responsePayload: params.result.responsePayload,
    httpStatusCode: params.result.httpStatus,
    latencyMs: params.result.latencyMs,
    retryCount: params.retryCount,
    idempotencyKey: params.idempotencyKey,
    isSuccess: params.result.ok,
    errorMessage: params.result.errorMessage,
    errorCode: params.result.errorCode,
    relatedEntity: 'orders',
    relatedRecordId: params.orderId,
    bullmqJobId: params.jobId ?? null,
  })
}

// -----------------------------------------------------------------------------
// Job processor
// -----------------------------------------------------------------------------

/** Structured error for non-retryable resolution failures within a job. */
class ErpSyncError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ErpSyncError'
  }
}

/** True when this is the last configured attempt (retries are exhausted). */
function isFinalAttempt(job: Job<ErpOrderSyncJobData>): boolean {
  const maxAttempts = job.opts.attempts ?? ERP_SYNC_MAX_ATTEMPTS
  return job.attemptsMade + 1 >= maxAttempts
}

/**
 * Processes one outbound ERP sync job. Resolves order + config under RLS, calls
 * the ERP gateway, logs the attempt, and applies the status transition. On a
 * failed call it only marks REJECTED_ERP on the final attempt, then rethrows so
 * BullMQ schedules the exponential backoff retry.
 */
export async function processErpOrderSyncJob(job: Job<ErpOrderSyncJobData>): Promise<void> {
  const { orderId, companyId, idempotencyKey } = job.data
  const rlsCtx: RLSContext = {
    companyId,
    userId: SYSTEM_USER_ID,
    userRole: SYSTEM_USER_ROLE,
  }

  const claimed = await claimIdempotencyKey(companyId, OUTBOUND_IDEMPOTENCY_SCOPE, idempotencyKey)
  if (!claimed && job.attemptsMade === 0) {
    // Duplicate first-delivery: another job already owns this key. Skip quietly.
    // On retries (attemptsMade > 0) the same job re-owns its key, so a lost
    // claim is expected and MUST NOT skip — this preserves retry safety.
    return
  }

  await withRLS(rlsCtx, async (tx) => {
    const config = await resolveErpConfig(tx, companyId)
    const header = await fetchSubmittedOrder(tx, orderId)
    const lines = await fetchQuotationLines(tx, orderId)
    const payload = buildQuotationPayload(header, lines, config, idempotencyKey)

    const result = await postToErp(config, payload)

    await writeSyncAudit(tx, {
      companyId,
      endpointUrl: config.endpointUrl,
      idempotencyKey,
      requestPayload: payload,
      result,
      retryCount: job.attemptsMade,
      orderId,
      jobId: job.id,
    })

    if (result.ok) {
      await markOrderSynced(tx, orderId, companyId, result.quotationNumber)
      return
    }

    if (isFinalAttempt(job)) {
      await markOrderRejected(tx, orderId, companyId, result)
    }
    throw new ErpSyncError(result.errorCode ?? 'ERP_SYNC_FAILED', result.errorMessage ?? 'ERP sync failed')
  })
}

// -----------------------------------------------------------------------------
// Worker bootstrap
// -----------------------------------------------------------------------------

let workerSingleton: Worker<ErpOrderSyncJobData> | null = null

/**
 * Creates (once) and returns the BullMQ Worker consuming the outbound ERP sync
 * queue. Uses an isolated Redis connection per BullMQ's requirement.
 *
 * CAVEAT: BullMQ requires `maxRetriesPerRequest: null` on its blocking
 * connection. `createRedisConnection()` sets that to null outside production; in
 * production it is `3`, which BullMQ tolerates for the worker's command
 * connection but is not its recommended blocking-connection setting. Revisit the
 * production Redis options if BullMQ emits a connection warning.
 */
export function createErpOrderSyncWorker(): Worker<ErpOrderSyncJobData> {
  if (!workerSingleton) {
    workerSingleton = new Worker<ErpOrderSyncJobData>(
      ERP_ORDER_SYNC_QUEUE,
      processErpOrderSyncJob,
      { connection: createRedisConnection() }
    )
  }
  return workerSingleton
}
