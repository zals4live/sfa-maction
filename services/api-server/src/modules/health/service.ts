import { sql } from '../../config/database'
import { redis } from '../../config/redis'

interface ServiceHealth {
  status: 'up' | 'down'
  latency_ms: number
}

const HEALTH_CHECK_TIMEOUT_MS = 3000

export async function checkDatabaseHealth(): Promise<ServiceHealth> {
  const start = performance.now()
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)
      ),
    ])
    return { status: 'up', latency_ms: Math.round(performance.now() - start) }
  } catch {
    return { status: 'down', latency_ms: Math.round(performance.now() - start) }
  }
}

export async function checkRedisHealth(): Promise<ServiceHealth> {
  const start = performance.now()
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)
      ),
    ])
    return { status: 'up', latency_ms: Math.round(performance.now() - start) }
  } catch {
    return { status: 'down', latency_ms: Math.round(performance.now() - start) }
  }
}
