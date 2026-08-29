import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ALL_ROLES } from '../../middleware/roleGuard'
import { withRLS } from '../../db'
import {
  ListMaterialsQuery,
  MaterialIdParams,
  MaterialPriceQuery,
  MaterialStockQuery,
  ListPromotionsQuery,
} from './schemas'
import {
  listMaterials,
  getMaterialById,
  getMaterialPrice,
  getMaterialStock,
  listPromotions,
  ServiceError,
} from './service'

/**
 * Material & pricing routes.
 * Read-only catalog access for all authenticated roles — both SALESMAN and MR
 * may look up materials, prices, and ATP stock. Lini scoping is enforced at the
 * RLS layer for field roles, so no Salesman-only role guard is applied here.
 */
export const materialRoutes = new Elysia({ prefix: '/materials' })
  .use(tenantGuard)
  .use(requireRole(...ALL_ROLES))
  .get(
    '/',
    async ({ query, claims }) => {
      return withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listMaterials(tx, query)
      )
    },
    { query: ListMaterialsQuery }
  )
  .get(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        const material = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => getMaterialById(tx, params.id)
        )
        return { data: material }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: MaterialIdParams }
  )
  .get(
    '/:id/price',
    async ({ params, query, claims, set }) => {
      try {
        const price = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => getMaterialPrice(tx, params.id, query)
        )
        return { data: price }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: MaterialIdParams, query: MaterialPriceQuery }
  )
  .get(
    '/:id/stock',
    async ({ params, query, claims, set }) => {
      try {
        const stock = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => getMaterialStock(tx, params.id, query)
        )
        return { data: stock }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: MaterialIdParams, query: MaterialStockQuery }
  )

/**
 * Promotions routes — sibling instance to materialRoutes (mirrors the
 * lini/varian sibling pattern). Read-accessible by all authenticated roles.
 */
export const promotionRoutes = new Elysia({ prefix: '/promotions' })
  .use(tenantGuard)
  .use(requireRole(...ALL_ROLES))
  .get(
    '/',
    async ({ query, claims }) => {
      return withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listPromotions(tx, query)
      )
    },
    { query: ListPromotionsQuery }
  )
