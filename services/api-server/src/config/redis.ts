import Redis from 'ioredis'
import type { RedisOptions } from 'ioredis'

const isProduction = process.env['NODE_ENV'] === 'production'

export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

if (isProduction && !process.env['REDIS_URL']) {
  throw new Error('REDIS_URL environment variable is required in production')
}

function buildRedisOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: isProduction ? 3 : null,
    retryStrategy(times: number): number | null {
      if (times > 10) return null
      return Math.min(times * 200, 5000)
    },
    tls: isProduction ? { rejectUnauthorized: true } : undefined,
    lazyConnect: false,
    enableReadyCheck: true,
    connectTimeout: 10_000,
  }
}

/** Primary Redis client for session store, rate-limiting, and dashboard cache */
export const redis = new Redis(REDIS_URL, buildRedisOptions())

/** Factory for creating isolated Redis connections (required by BullMQ workers) */
export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL, buildRedisOptions())
}
