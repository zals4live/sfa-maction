import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { getSession } from '../config/session'

/** Valid role labels for JWT claims (includes MR which may not be in enum yet) */
const VALID_ROLES = [
  'SUPER_ADMIN',
  'ADMIN_PUSAT',
  'ADMIN_CABANG',
  'SALESMAN',
  'MR',
] as const

export type RoleLabel = (typeof VALID_ROLES)[number]

/** Decoded JWT claims attached to request context by tenantGuard */
export interface JWTClaims {
  user_id: string
  company_id: string
  soffice_id: string
  role_label: RoleLabel
  lini_ids: string[]
  /** Per-login identifier; must match the current Redis session (FR-AUTH-02). */
  session_id: string
}

function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isValidRole(value: unknown): value is RoleLabel {
  return typeof value === 'string' && VALID_ROLES.includes(value as RoleLabel)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null
  const parts = authorization.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null
  return parts[1] ?? null
}

function validateClaims(payload: Record<string, unknown>): JWTClaims | null {
  const { user_id, company_id, soffice_id, role_label, lini_ids, session_id } = payload
  if (!isValidUUID(user_id)) return null
  if (!isValidUUID(company_id)) return null
  if (!isValidUUID(soffice_id)) return null
  if (!isValidRole(role_label)) return null
  if (!isStringArray(lini_ids)) return null
  if (!isValidUUID(session_id)) return null
  return { user_id, company_id, soffice_id, role_label, lini_ids, session_id }
}

function getJWTSecret(): string {
  const secret = process.env['JWT_SECRET']
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required')
  }
  return secret
}

/**
 * Tenant-guard Elysia plugin.
 * Extracts and validates JWT from the Authorization header,
 * then derives decoded claims into request context for downstream handlers.
 *
 * Does NOT set RLS context — that responsibility belongs to the service layer via withRLS().
 */
export const tenantGuard = new Elysia({ name: 'tenantGuard' })
  .use(
    jwt({
      name: 'jwt',
      secret: getJWTSecret(),
    })
  )
  .derive(async ({ jwt: jwtPlugin, headers }) => {
    const token = extractBearerToken(headers['authorization'])
    if (!token) {
      return {
        claims: null as JWTClaims | null,
        authError: 'Missing or malformed Authorization header' as string | null,
      }
    }

    const payload = await jwtPlugin.verify(token)
    if (!payload) {
      return {
        claims: null as JWTClaims | null,
        authError: 'Invalid or expired token' as string | null,
      }
    }

    const claims = validateClaims(payload as Record<string, unknown>)
    if (!claims) {
      return {
        claims: null as JWTClaims | null,
        authError: 'Token payload missing required claims' as string | null,
      }
    }

    const session = await getSession(claims.company_id, claims.user_id)
    // Reject when no session exists (logout / expiry / kill-switch) OR when the
    // token's session_id no longer matches the current session — i.e. a newer login
    // from another device has superseded this token (single active session, FR-AUTH-02).
    if (!session || session.session_id !== claims.session_id) {
      return {
        claims: null as JWTClaims | null,
        authError: 'Session has been invalidated. Please re-authenticate.' as string | null,
      }
    }

    return { claims: claims as JWTClaims | null, authError: null as string | null }
  })
  .onBeforeHandle(({ claims, authError, set }) => {
    if (!claims || authError) {
      set.status = 401
      const isSessionInvalidated = authError === 'Session has been invalidated. Please re-authenticate.'
      return {
        error: {
          code: isSessionInvalidated ? 'SESSION_INVALIDATED' : 'UNAUTHORIZED',
          message: authError ?? 'Authentication required',
        },
      }
    }
  })
  .as('scoped')
