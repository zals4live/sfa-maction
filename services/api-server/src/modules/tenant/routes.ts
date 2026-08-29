import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, SUPER_ADMIN_ONLY } from '../../middleware/roleGuard'
import {
  CreateCompanyBody,
  UpdateCompanyBody,
  UpdateERPConfigBody,
  ListCompaniesQuery,
  CompanyIdParams,
} from './schemas'
import {
  createCompany,
  listCompanies,
  updateCompany,
  updateERPConfig,
  deactivateCompany,
  ServiceError,
} from './service'

export const tenantRoutes = new Elysia({ prefix: '/tenants' })
  .use(tenantGuard)
  .use(requireRole(...SUPER_ADMIN_ONLY))
  .get(
    '/',
    async ({ query }) => {
      const result = await listCompanies(query)
      return result
    },
    { query: ListCompaniesQuery }
  )
  .post(
    '/',
    async ({ body, set }) => {
      try {
        const company = await createCompany(body)
        set.status = 201
        return { data: company }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: CreateCompanyBody }
  )
  .patch(
    '/:id',
    async ({ params, body, set }) => {
      try {
        const company = await updateCompany(params.id, body)
        return { data: company }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CompanyIdParams, body: UpdateCompanyBody }
  )
  .put(
    '/:id/erp-config',
    async ({ params, body, set }) => {
      try {
        const company = await updateERPConfig(params.id, body)
        return { data: company }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CompanyIdParams, body: UpdateERPConfigBody }
  )
  .patch(
    '/:id/deactivate',
    async ({ params, set }) => {
      try {
        await deactivateCompany(params.id)
        return { data: { success: true } }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CompanyIdParams }
  )
