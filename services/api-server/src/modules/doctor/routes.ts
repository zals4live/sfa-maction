import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ALL_ROLES } from '../../middleware/roleGuard'
import { withRLS } from '../../db'
import {
  DoctorIdParams,
  AssignmentIdParams,
  ListDoctorsQuery,
  UpdateDoctorProfileBody,
  CreateAssignmentBody,
  UpdateAssignmentBody,
} from './schemas'
import {
  listDoctors,
  getDoctorById,
  updateDoctorProfile,
  listAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  ServiceError,
} from './service'

export const doctorRoutes = new Elysia({ prefix: '/doctors' })
  .use(tenantGuard)
  .use(requireRole(...ALL_ROLES))
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listDoctors(tx, query)
      )
      return result
    },
    { query: ListDoctorsQuery }
  )
  .get(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        const doctor = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => getDoctorById(tx, params.id)
        )
        return { data: doctor }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: DoctorIdParams }
  )
  .patch(
    '/:id/profile',
    async ({ params, body, claims, set }) => {
      try {
        const profile = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => updateDoctorProfile(tx, params.id, body)
        )
        return { data: profile }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: DoctorIdParams, body: UpdateDoctorProfileBody }
  )
  .get(
    '/:id/assignments',
    async ({ params, claims, set }) => {
      try {
        const result = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => listAssignments(tx, params.id)
        )
        return result
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: DoctorIdParams }
  )
  .post(
    '/:id/assignments',
    async ({ params, body, claims, set }) => {
      try {
        const assignment = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => createAssignment(tx, claims!.company_id, params.id, body)
        )
        set.status = 201
        return { data: assignment }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: DoctorIdParams, body: CreateAssignmentBody }
  )
  .patch(
    '/:id/assignments/:assignmentId',
    async ({ params, body, claims, set }) => {
      try {
        const assignment = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => updateAssignment(tx, params.assignmentId, body)
        )
        return { data: assignment }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: AssignmentIdParams, body: UpdateAssignmentBody }
  )
  .delete(
    '/:id/assignments/:assignmentId',
    async ({ params, claims, set }) => {
      try {
        await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => deleteAssignment(tx, params.assignmentId, claims!.user_id)
        )
        return { data: { success: true } }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: AssignmentIdParams }
  )
