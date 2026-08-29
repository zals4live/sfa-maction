import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ADMIN_PUSAT_UP } from '../../middleware/roleGuard'
import { withRLS } from '../../db'
import {
  CreateLiniBody,
  UpdateLiniBody,
  ListLiniQuery,
  LiniIdParams,
  CreateVarianBody,
  UpdateVarianBody,
  ListVarianQuery,
  VarianIdParams,
  UserIdParams,
  UserLiniDeleteParams,
  ListUserLiniQuery,
  AssignUserLiniBody,
} from './schemas'
import {
  createLini,
  listLini,
  getLiniById,
  updateLini,
  deleteLini,
  createVarian,
  listVarian,
  getVarianById,
  updateVarian,
  deleteVarian,
  listUserLiniAssignments,
  assignUserLini,
  removeUserLiniAssignment,
  ServiceError,
} from './service'

export const liniRoutes = new Elysia({ prefix: '/lini' })
  .use(tenantGuard)
  .use(requireRole(...ADMIN_PUSAT_UP))
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listLini(tx, query)
      )
      return result
    },
    { query: ListLiniQuery }
  )
  .post(
    '/',
    async ({ body, claims, set }) => {
      try {
        const lini = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => createLini(tx, claims!.company_id, body)
        )
        set.status = 201
        return { data: lini }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: CreateLiniBody }
  )
  .get(
    '/:id',
    async ({ params, claims }) => {
      const lini = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => getLiniById(tx, params.id)
      )
      return { data: lini }
    },
    { params: LiniIdParams }
  )
  .patch(
    '/:id',
    async ({ params, body, claims, set }) => {
      try {
        const lini = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => updateLini(tx, params.id, body)
        )
        return { data: lini }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: LiniIdParams, body: UpdateLiniBody }
  )
  .delete(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => deleteLini(tx, params.id, claims!.user_id)
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
    { params: LiniIdParams }
  )

export const varianRoutes = new Elysia({ prefix: '/varian' })
  .use(tenantGuard)
  .use(requireRole(...ADMIN_PUSAT_UP))
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listVarian(tx, query)
      )
      return result
    },
    { query: ListVarianQuery }
  )
  .post(
    '/',
    async ({ body, claims, set }) => {
      try {
        const varian = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => createVarian(tx, claims!.company_id, body)
        )
        set.status = 201
        return { data: varian }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: CreateVarianBody }
  )
  .get(
    '/:id',
    async ({ params, claims }) => {
      const varian = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => getVarianById(tx, params.id)
      )
      return { data: varian }
    },
    { params: VarianIdParams }
  )
  .patch(
    '/:id',
    async ({ params, body, claims, set }) => {
      try {
        const varian = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => updateVarian(tx, params.id, body)
        )
        return { data: varian }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: VarianIdParams, body: UpdateVarianBody }
  )
  .delete(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => deleteVarian(tx, params.id, claims!.user_id)
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
    { params: VarianIdParams }
  )


export const userLiniRoutes = new Elysia({ prefix: '/users' })
  .use(tenantGuard)
  .use(requireRole(...ADMIN_PUSAT_UP))
  .get(
    '/:userId/lini',
    async ({ params, query, claims }) => {
      const result = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listUserLiniAssignments(tx, params.userId, query)
      )
      return result
    },
    { params: UserIdParams, query: ListUserLiniQuery }
  )
  .post(
    '/:userId/lini',
    async ({ params, body, claims, set }) => {
      try {
        const assignments = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => assignUserLini(tx, claims!.company_id, params.userId, body.lini_ids)
        )
        set.status = 201
        return { data: assignments }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: UserIdParams, body: AssignUserLiniBody }
  )
  .delete(
    '/:userId/lini/:liniId',
    async ({ params, claims, set }) => {
      try {
        await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => removeUserLiniAssignment(tx, params.userId, params.liniId)
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
    { params: UserLiniDeleteParams }
  )
