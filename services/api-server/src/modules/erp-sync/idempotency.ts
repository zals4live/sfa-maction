import { randomUUID } from 'node:crypto'

import { redis } from '../../config/redis'

// =============================================================================
// Shared ERP idempotency layer — Redis-backed at-most-once delivery.
//
// A single, tenant + scope namespaced idempotency utility used by BOTH the
// inbound webhook service (erp-sync/service.ts) and the outbound order worker
// (queues/erpSyncWorker.ts). Every ERP request carries a unique idempotency
// key; before applying it we atomically claim the key in Redis (SET NX with a
// 24h TTL). A failed claim means the key was already processed within the
// window, so the caller short-circuits — mirroring the security steering's
// at-most-once requirement for ERP integration.
//
// The `scope` segment prevents cross-direction collisions: inbound uses scopes
// like 'customers'/'materials'/'prices', outbound uses 'order'.
// =============================================================================

/** Redis key namespace for all ERP idempotency claims. */
export const IDEMPOTENCY_PREFIX = 'erp:idempotency'

/** TTL for idempotency keys: 24 hours (seconds). */
export const IDEMPOTENCY_TTL_SECONDS = 86_400

/** Generates a fresh UUID v4 idempotency key for an outbound ERP request. */
export function generateIdempotencyKey(): string {
  return randomUUID()
}

/** Builds the Redis key for an ERP idempotency claim, scoped by tenant + scope. */
export function buildIdempotencyKey(companyId: string, scope: string, key: string): string {
  return `${IDEMPOTENCY_PREFIX}:${companyId}:${scope}:${key}`
}

/**
 * Atomically claims an idempotency key. Returns true when the caller won the
 * claim (first processing), false when the key was already processed within the
 * TTL window (duplicate delivery). Uses a single atomic Redis SET NX EX op.
 */
export async function claimIdempotencyKey(
  companyId: string,
  scope: string,
  key: string
): Promise<boolean> {
  const redisKey = buildIdempotencyKey(companyId, scope, key)
  const result = await redis.set(redisKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX')
  return result === 'OK'
}
