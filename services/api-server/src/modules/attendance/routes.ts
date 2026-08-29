import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, FIELD_FORCE } from '../../middleware/roleGuard'
import {
  CheckInBody,
  CheckOutBody,
  AttendanceHistoryQuery,
  UploadUrlBody,
} from './schemas'
import {
  checkIn,
  checkOut,
  getTodayAttendance,
  getAttendanceHistory,
  generateSelfieUploadUrl,
  ServiceError,
} from './service'

export const attendanceRoutes = new Elysia({ prefix: '/attendance' })
  .use(tenantGuard)
  .use(requireRole(...FIELD_FORCE))
  .post(
    '/check-in',
    async ({ body, claims, set }) => {
      try {
        const result = await checkIn(body, {
          companyId: claims!.company_id,
          userId: claims!.user_id,
          sofficeId: claims!.soffice_id,
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
    { body: CheckInBody }
  )
  .post(
    '/check-out',
    async ({ body, claims, set }) => {
      try {
        const result = await checkOut(body, {
          companyId: claims!.company_id,
          userId: claims!.user_id,
          sofficeId: claims!.soffice_id,
          userRole: claims!.role_label,
        })
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: CheckOutBody }
  )
  .get(
    '/today',
    async ({ claims }) => {
      const result = await getTodayAttendance({
        companyId: claims!.company_id,
        userId: claims!.user_id,
        sofficeId: claims!.soffice_id,
        userRole: claims!.role_label,
      })
      return { data: result }
    }
  )
  .get(
    '/history',
    async ({ query, claims }) => {
      const result = await getAttendanceHistory(query, {
        companyId: claims!.company_id,
        userId: claims!.user_id,
        sofficeId: claims!.soffice_id,
        userRole: claims!.role_label,
      })
      return result
    },
    { query: AttendanceHistoryQuery }
  )
  .post(
    '/upload-url',
    async ({ body, claims, set }) => {
      try {
        const result = await generateSelfieUploadUrl(body, {
          companyId: claims!.company_id,
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
    { body: UploadUrlBody }
  )
