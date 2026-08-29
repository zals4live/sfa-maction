import { Elysia } from 'elysia'
import type { RoleLabel, JWTClaims } from './tenantGuard'

/** Context shape provided by tenantGuard upstream */
interface TenantContext {
  claims: JWTClaims | null
}

/**
 * Factory function that returns an Elysia plugin enforcing role-based access.
 * Must be applied AFTER tenantGuard so `claims` exists in context.
 */
export function requireRole(...allowedRoles: RoleLabel[]) {
  return new Elysia({ name: `roleGuard:${allowedRoles.join(',')}` })
    .onBeforeHandle(({ set, ...ctx }) => {
      const { claims } = ctx as unknown as TenantContext

      if (!claims) {
        set.status = 401
        return {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          },
        }
      }

      if (!allowedRoles.includes(claims.role_label)) {
        set.status = 403
        return {
          error: {
            code: 'FORBIDDEN',
            message: `Insufficient permissions. Required role: ${allowedRoles.join(', ')}`,
          },
        }
      }
    })
    .as('scoped')
}

/** Only SALESMAN — used for order write endpoints (create, submit, PDF) */
export const SALESMAN_ONLY: RoleLabel[] = ['SALESMAN']

/**
 * SALESMAN + admin roles — used for order read endpoints (list, detail).
 * MR is intentionally excluded: MR is barred from all order access per the
 * orders RLS policy. Admins need read access for order approval/review.
 */
export const ORDER_READERS: RoleLabel[] = ['SALESMAN', 'ADMIN_CABANG', 'ADMIN_PUSAT', 'SUPER_ADMIN']

/** SALESMAN and MR — for visit, attendance, and field operations */
export const FIELD_FORCE: RoleLabel[] = ['SALESMAN', 'MR']

/** ADMIN_CABANG, ADMIN_PUSAT, SUPER_ADMIN — for admin portal endpoints */
export const ADMIN_ONLY: RoleLabel[] = ['ADMIN_CABANG', 'ADMIN_PUSAT', 'SUPER_ADMIN']

/** ADMIN_PUSAT, SUPER_ADMIN — for tenant-wide operations */
export const ADMIN_PUSAT_UP: RoleLabel[] = ['ADMIN_PUSAT', 'SUPER_ADMIN']

/** Only SUPER_ADMIN — for cross-tenant operations */
export const SUPER_ADMIN_ONLY: RoleLabel[] = ['SUPER_ADMIN']

/** All five roles — for endpoints accessible to everyone */
export const ALL_ROLES: RoleLabel[] = [
  'SUPER_ADMIN',
  'ADMIN_PUSAT',
  'ADMIN_CABANG',
  'SALESMAN',
  'MR',
]
