import { redis } from './redis'

/** Session key pattern: session:{company_id}:{user_id} */
const SESSION_PREFIX = 'session'

/** Default TTL: 24 hours for field force (SALESMAN, MR) */
export const SESSION_TTL_FIELD = 86400

/** Default TTL: 8 hours for admin roles */
export const SESSION_TTL_ADMIN = 28800

export interface SessionData {
  company_id: string
  user_id: string
  soffice_id: string
  role_label: string
  ip: string
  created_at: string
}

/** Builds the Redis key for a user session. */
export function buildSessionKey(companyId: string, userId: string): string {
  return `${SESSION_PREFIX}:${companyId}:${userId}`
}

/** Stores a session in Redis with the given TTL (seconds). */
export async function createSession(
  companyId: string,
  userId: string,
  data: SessionData,
  ttlSeconds: number
): Promise<void> {
  const key = buildSessionKey(companyId, userId)
  await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds)
}

/** Retrieves a session from Redis. Returns null if not found or expired. */
export async function getSession(
  companyId: string,
  userId: string
): Promise<SessionData | null> {
  const key = buildSessionKey(companyId, userId)
  const raw = await redis.get(key)
  if (!raw) return null
  return JSON.parse(raw) as SessionData
}

/** Deletes a specific user session from Redis. */
export async function deleteSession(
  companyId: string,
  userId: string
): Promise<void> {
  const key = buildSessionKey(companyId, userId)
  await redis.del(key)
}
