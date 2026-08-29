// TODO: Implement material & pricing routes
// - GET /materials — paginated list (lini-filtered by RLS for field roles)
// - GET /materials/:id — detail with UOM conversion rules
// - GET /materials/:id/price — current price for branch + variant
// - GET /materials/:id/stock — ATP stock with batch & SLED
// - GET /promotions — active promotions
// Note: Both SALESMAN and MR can access read endpoints

import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ALL_ROLES } from '../../middleware/roleGuard'

export const materialRoutes = new Elysia({ prefix: '/materials' })
  .use(tenantGuard)
  .use(requireRole(...ALL_ROLES))
