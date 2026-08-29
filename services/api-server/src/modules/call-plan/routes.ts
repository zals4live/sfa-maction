import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ALL_ROLES, ADMIN_ONLY } from '../../middleware/roleGuard'
import {
  ListCallPlansQuery,
  BulkUploadCallPlanBody,
  TodayCallPlansQuery,
  CallPlanAnalyticsQuery,
} from './schemas'
import {
  listCallPlans,
  bulkCreatePlans,
  getTodayPlans,
  getCallPlanAnalytics,
  ServiceError,
} from './service'

export const callPlanRoutes = new Elysia({ prefix: '/call-plans' })
  .use(tenantGuard)
  .use(requireRole(...ALL_ROLES))
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await listCallPlans(query, {
        companyId: claims!.company_id,
        userId: claims!.user_id,
        userRole: claims!.role_label,
      })
      return result
    },
    { query: ListCallPlansQuery }
  )
  .post(
    '/bulk-upload',
    async ({ body, claims, set }) => {
      const adminRoles: string[] = ['ADMIN_CABANG', 'ADMIN_PUSAT', 'SUPER_ADMIN']
      if (!adminRoles.includes(claims!.role_label)) {
        set.status = 403
        return {
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions. Required role: ADMIN_CABANG, ADMIN_PUSAT, SUPER_ADMIN',
          },
        }
      }

      try {
        const result = await bulkCreatePlans(body, {
          companyId: claims!.company_id,
          userId: claims!.user_id,
          userRole: claims!.role_label,
        })
        set.status = 201
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: BulkUploadCallPlanBody }
  )
  .get(
    '/today',
    async ({ query, claims }) => {
      const result = await getTodayPlans(query, {
        companyId: claims!.company_id,
        userId: claims!.user_id,
        userRole: claims!.role_label,
      })
      return result
    },
    { query: TodayCallPlansQuery }
  )
  .get(
    '/analytics',
    async ({ query, claims, set }) => {
      const adminRoles: string[] = ['ADMIN_CABANG', 'ADMIN_PUSAT', 'SUPER_ADMIN']
      if (!adminRoles.includes(claims!.role_label)) {
        set.status = 403
        return {
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions. Required role: ADMIN_CABANG, ADMIN_PUSAT, SUPER_ADMIN',
          },
        }
      }

      try {
        const result = await getCallPlanAnalytics(query, {
          companyId: claims!.company_id,
          userId: claims!.user_id,
          userRole: claims!.role_label,
        })
        return result
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { query: CallPlanAnalyticsQuery }
  )
