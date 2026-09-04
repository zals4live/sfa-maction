import { eq, and } from 'drizzle-orm'

import { db } from '../../db'
import { appUsers, userLiniAssignments } from '../../db/schema/auth'
import {
  createSession,
  deleteSession,
  SESSION_TTL_FIELD,
  SESSION_TTL_ADMIN,
} from '../../config/session'
import type { SessionData } from '../../config/session'
import type { LoginInput, UserProfile } from './schemas'

// --- Error Class ---

/** Structured service error for route-level handling. */
export class AuthServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
  }
}

// --- JWT Utilities ---

const FIELD_ROLES = ['SALESMAN', 'MR'] as const

function getJWTSecret(): string {
  const secret = process.env['JWT_SECRET']
  if (!secret) throw new Error('JWT_SECRET environment variable is required')
  return secret
}

function getSessionTTL(role: string): number {
  return (FIELD_ROLES as readonly string[]).includes(role)
    ? SESSION_TTL_FIELD
    : SESSION_TTL_ADMIN
}

function base64url(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64url')
}

function encodePayload(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

/** Signs a JWT with HMAC-SHA256, compatible with @elysiajs/jwt verification. */
export async function signJWT(
  payload: Record<string, unknown>,
  ttlSeconds: number
): Promise<string> {
  const secret = getJWTSecret()
  const header = encodePayload({ alg: 'HS256', typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)

  const body = encodePayload({ ...payload, iat: now, exp: now + ttlSeconds })
  const signingInput = `${header}.${body}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput)
  )

  return `${signingInput}.${base64url(signature)}`
}

// --- Query Helpers ---

/** Fetches active lini_ids for a user. */
async function fetchLiniIds(
  companyId: string,
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ liniId: userLiniAssignments.liniId })
    .from(userLiniAssignments)
    .where(
      and(
        eq(userLiniAssignments.companyId, companyId),
        eq(userLiniAssignments.userId, userId),
        eq(userLiniAssignments.isActive, true)
      )
    )

  return rows.map((r) => r.liniId)
}

/** Fetches a single active, non-deleted user by email. */
async function findUserByEmail(email: string) {
  const rows = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.email, email.toLowerCase().trim()))
    .limit(1)

  const user = rows[0]
  if (!user || user.isDeleted || !user.isActive) return null
  return user
}

/** Fetches a single active, non-deleted user by ID. */
async function findUserById(userId: string) {
  const rows = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1)

  const user = rows[0]
  if (!user || user.isDeleted || !user.isActive) return null
  return user
}

// --- Mapping ---

type UserRow = typeof appUsers.$inferSelect

function mapToUserProfile(row: UserRow, liniIds: string[]): UserProfile {
  return {
    id: row.id,
    company_id: row.companyId,
    soffice_id: row.sofficeId ?? null,
    email: row.email,
    full_name: row.fullName,
    phone_number: row.phoneNumber ?? null,
    role_label: row.roleLabel as UserProfile['role_label'],
    avatar_s3_key: row.avatarS3Key ?? null,
    lini_ids: liniIds,
  }
}

// --- Public Service Functions ---

/** Authenticates a user, creates a session, and returns token + profile. */
export async function login(
  input: LoginInput,
  clientIp: string
): Promise<{ token: string; user: UserProfile }> {
  const user = await findUserByEmail(input.email)
  if (!user) {
    throw new AuthServiceError(
      'INVALID_CREDENTIALS',
      'Invalid email or password',
      401
    )
  }

  const valid = await Bun.password.verify(input.password, user.passwordHash)
  if (!valid) {
    throw new AuthServiceError(
      'INVALID_CREDENTIALS',
      'Invalid email or password',
      401
    )
  }

  const liniIds = await fetchLiniIds(user.companyId, user.id)
  const ttl = getSessionTTL(user.roleLabel)

  // Unique per-login identifier bound into both the Redis session and the JWT.
  // A new login overwrites this value, so the prior device's token — carrying the
  // old session_id — no longer matches and is rejected (FR-AUTH-02).
  const sessionId = crypto.randomUUID()

  // Invalidate prior session (single-session enforcement) then create new one
  await deleteSession(user.companyId, user.id)

  const sessionData: SessionData = {
    session_id: sessionId,
    company_id: user.companyId,
    user_id: user.id,
    soffice_id: user.sofficeId ?? '',
    role_label: user.roleLabel,
    ip: clientIp,
    created_at: new Date().toISOString(),
  }
  await createSession(user.companyId, user.id, sessionData, ttl)

  // Update current_session_ip in app_users
  await db
    .update(appUsers)
    .set({ currentSessionIp: clientIp })
    .where(eq(appUsers.id, user.id))

  const token = await signJWT(
    {
      user_id: user.id,
      company_id: user.companyId,
      soffice_id: user.sofficeId ?? '',
      role_label: user.roleLabel,
      lini_ids: liniIds,
      session_id: sessionId,
    },
    ttl
  )

  return { token, user: mapToUserProfile(user, liniIds) }
}

/** Destroys a user's session from Redis. */
export async function logout(
  companyId: string,
  userId: string
): Promise<void> {
  await deleteSession(companyId, userId)
}

/** Retrieves the user profile with current lini_ids for /auth/me. */
export async function getUserProfile(userId: string): Promise<UserProfile> {
  const user = await findUserById(userId)
  if (!user) {
    throw new AuthServiceError('USER_NOT_FOUND', 'User not found', 404)
  }

  const liniIds = await fetchLiniIds(user.companyId, user.id)
  return mapToUserProfile(user, liniIds)
}
