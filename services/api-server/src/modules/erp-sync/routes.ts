// TODO: Implement ERP integration webhook routes
// - POST /erp/webhook/customers — inbound customer delta sync
// - POST /erp/webhook/materials — inbound SKU sync (with lini_id)
// - POST /erp/webhook/prices — inbound price list sync (with varian_id)
// - POST /erp/webhook/stock — inbound ATP sync (with batch & SLED)
// - POST /erp/webhook/promotions — inbound promo sync
// - POST /erp/webhook/leads — new leads → auto-create visit plans

import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, SUPER_ADMIN_ONLY } from '../../middleware/roleGuard'

export const erpSyncRoutes = new Elysia({ prefix: '/erp' })
  .use(tenantGuard)
  .use(requireRole(...SUPER_ADMIN_ONLY))
