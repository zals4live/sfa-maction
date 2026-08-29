import { Elysia } from 'elysia'
import { redis } from '../config/redis'
import type { JWTClaims } from './tenantGuard'

/** Configuration for a rate limiter instance */
export interface RateLimitOptions {
  /** Max requests allowed in the window */
  maxRequests: number
  /** Time window in seconds */
  windowSeconds: number
  /** Key prefix for Redis (avoids collisions between different limiters) */
  prefix: string
  /** Strategy for identifying the requester: 'user' | 'tenant' | 'ip' */
  keyStrategy: 'user' | 'tenant' | 'ip'
}

/** Context shape provided by tenantGuard upstream */
interface TenantContext {
  claims: JWTClaims | null
}

/**
 * Extracts the client IP from request headers,
 * respecting X-Forwarded-For from Nginx reverse proxy.
 */
function getClientIp(headers: Record<string, string | undefined>): string {
  const forwarded = headers['x-forwarded-for']
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown'
  }
  return headers['x-real-ip'] ?? 'unknown'
}

/**
 * Builds the Redis key based on the strategy and request context.
 */
function buildRateLimitKey(
  prefix: string,
  strategy: RateLimitOptions['keyStrategy'],
  claims: JWTClaims | null,
  clientIp: string
): string {
  switch (strategy) {
    case 'user':
      return `rl:${prefix}:u:${claims?.user_id ?? clientIp}`
    case 'tenant':
      return `rl:${prefix}:t:${claims?.company_id ?? clientIp}`
    case 'ip':
      return `rl:${prefix}:ip:${clientIp}`
  }
}

/**
 * Checks the rate limit using Redis INCR + EXPIRE (fixed window counter).
 * Returns remaining requests or -1 if limit exceeded.
 */
async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const current = await redis.incr(key)

  if (current === 1) {
    await redis.expire(key, windowSeconds)
  }

  const ttl = await redis.ttl(key)
  const retryAfter = ttl > 0 ? ttl : windowSeconds

  if (current > maxRequests) {
    return { allowed: false, remaining: 0, retryAfter }
  }

  return { allowed: true, remaining: maxRequests - current, retryAfter: 0 }
}

/**
 * Factory function that creates a configurable Elysia rate-limiting plugin.
 * Can be applied to any route group with custom limits.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { maxRequests, windowSeconds, prefix, keyStrategy } = options

  return new Elysia({ name: `rateLimiter:${prefix}` })
    .onBeforeHandle(async ({ set, headers, ...ctx }) => {
      const { claims } = ctx as unknown as TenantContext
      const clientIp = getClientIp(headers as Record<string, string | undefined>)
      const key = buildRateLimitKey(prefix, keyStrategy, claims, clientIp)
      const result = await checkRateLimit(key, maxRequests, windowSeconds)

      set.headers['X-RateLimit-Limit'] = String(maxRequests)
      set.headers['X-RateLimit-Remaining'] = String(result.remaining)

      if (!result.allowed) {
        set.status = 429
        set.headers['Retry-After'] = String(result.retryAfter)
        return {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Too many requests. Please retry after ${result.retryAfter} seconds.`,
            details: {
              limit: maxRequests,
              window_seconds: windowSeconds,
              retry_after: result.retryAfter,
            },
          },
        }
      }
    })
    .as('scoped')
}

/**
 * Default rate limiter combining per-user (100/min) and per-tenant (1000/min) limits.
 * Falls back to IP-based limiting when user is unauthenticated.
 */
export const rateLimiter = new Elysia({ name: 'rateLimiter:default' })
  .onBeforeHandle(async ({ set, headers, ...ctx }) => {
    const { claims } = ctx as unknown as TenantContext
    const clientIp = getClientIp(headers as Record<string, string | undefined>)

    // Check per-user limit (100 req/min)
    const userKey = buildRateLimitKey('default', 'user', claims, clientIp)
    const userResult = await checkRateLimit(userKey, 100, 60)

    if (!userResult.allowed) {
      set.status = 429
      set.headers['Retry-After'] = String(userResult.retryAfter)
      set.headers['X-RateLimit-Limit'] = '100'
      set.headers['X-RateLimit-Remaining'] = '0'
      return {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Please retry after ${userResult.retryAfter} seconds.`,
          details: {
            limit: 100,
            window_seconds: 60,
            retry_after: userResult.retryAfter,
          },
        },
      }
    }

    // Check per-tenant limit (1000 req/min) — only when authenticated
    if (claims) {
      const tenantKey = buildRateLimitKey('default', 'tenant', claims, clientIp)
      const tenantResult = await checkRateLimit(tenantKey, 1000, 60)

      if (!tenantResult.allowed) {
        set.status = 429
        set.headers['Retry-After'] = String(tenantResult.retryAfter)
        set.headers['X-RateLimit-Limit'] = '1000'
        set.headers['X-RateLimit-Remaining'] = '0'
        return {
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Tenant rate limit exceeded. Please retry after ${tenantResult.retryAfter} seconds.`,
            details: {
              limit: 1000,
              window_seconds: 60,
              retry_after: tenantResult.retryAfter,
            },
          },
        }
      }
    }

    set.headers['X-RateLimit-Limit'] = '100'
    set.headers['X-RateLimit-Remaining'] = String(userResult.remaining)
  })
  .as('scoped')

/** Pre-configured rate limiter for auth/login endpoints: 5 attempts/min per IP */
export const authRateLimiter = createRateLimiter({
  maxRequests: 5,
  windowSeconds: 60,
  prefix: 'auth',
  keyStrategy: 'ip',
})

/** Pre-configured rate limiter for S3 pre-signed URL generation: 30 req/min per user */
export const uploadRateLimiter = createRateLimiter({
  maxRequests: 30,
  windowSeconds: 60,
  prefix: 'upload',
  keyStrategy: 'user',
})
