import { redis } from '../config/redis'

/**
 * Generic cache-aside helper backed by the shared Redis client.
 *
 * On a cache hit the stored JSON is parsed and returned; on a miss the
 * `producer` is invoked, its result stored with the given TTL, then returned.
 * Redis failures (unavailable, timeout, malformed payload) are swallowed and
 * the request falls back to the fresh `producer` value — caching must never
 * cause a request to fail.
 *
 * @param key     Fully-qualified cache key (caller is responsible for scoping).
 * @param ttlSeconds  Time-to-live for the cached entry, in seconds.
 * @param producer  Async function computing the fresh value on a miss.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  producer: () => Promise<T>
): Promise<T> {
  const hit = await readCache<T>(key)
  if (hit.found) return hit.value

  const fresh = await producer()
  await writeCache(key, ttlSeconds, fresh)
  return fresh
}

/** Reads and parses a cached value, treating any Redis/JSON error as a miss. */
async function readCache<T>(key: string): Promise<{ found: true; value: T } | { found: false }> {
  try {
    const raw = await redis.get(key)
    if (raw === null) return { found: false }
    return { found: true, value: JSON.parse(raw) as T }
  } catch {
    // Redis unavailable or corrupt payload — degrade to a cache miss.
    return { found: false }
  }
}

/** Stores a value with a TTL, swallowing any Redis error. */
async function writeCache<T>(key: string, ttlSeconds: number, value: T): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch {
    // Best-effort write; a failed SET must not affect the response.
  }
}
