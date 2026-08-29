import { Elysia } from 'elysia'
import { eq, and } from 'drizzle-orm'

import { db } from '../db'
import { absensi } from '../db/schema/auth'
import type { JWTClaims, RoleLabel } from './tenantGuard'

/** Roles that bypass the attendance lock (admin roles). */
const BYPASS_ROLES: RoleLabel[] = ['SUPER_ADMIN', 'ADMIN_PUSAT', 'ADMIN_CABANG']

/** Context shape provided by tenantGuard upstream. */
interface TenantContext {
  claims: JWTClaims | null
}

/** Returns today's date as YYYY-MM-DD string. */
function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0]!
}

/**
 * Elysia plugin that enforces attendance lock for field force users.
 * Must be applied AFTER tenantGuard and roleGuard so `claims` exists in context.
 *
 * Blocks access with 403 if a SALESMAN or MR has not checked in today.
 * Admin roles bypass this check entirely.
 */
export const attendanceLock = new Elysia({ name: 'attendanceLock' })
  .onBeforeHandle(async ({ set, ...ctx }) => {
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

    // Admin roles bypass attendance lock
    if (BYPASS_ROLES.includes(claims.role_label)) {
      return
    }

    // Check if field force user has a valid check-in today
    const today = getTodayDateString()

    const [record] = await db
      .select({ id: absensi.id })
      .from(absensi)
      .where(
        and(
          eq(absensi.companyId, claims.company_id),
          eq(absensi.userId, claims.user_id),
          eq(absensi.attendanceDate, today)
        )
      )
      .limit(1)

    if (!record) {
      set.status = 403
      return {
        error: {
          code: 'ATTENDANCE_REQUIRED',
          message: 'You must check in before accessing visit features.',
        },
      }
    }
  })
  .as('scoped')
