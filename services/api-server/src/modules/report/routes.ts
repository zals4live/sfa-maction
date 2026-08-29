// TODO: Implement reporting routes
// - GET /reports/dashboard-kpi — executive KPI (Salesman vs MR segmented)
// - GET /reports/branch-performance — branch matrix
// - GET /reports/call-rate — call rate by user/branch/tenant
// - GET /reports/orders — order transaction register
// - GET /reports/fraud-incidents — fraud telemetry query
// - GET /reports/export/:type — streaming Excel/PDF export

import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ADMIN_ONLY } from '../../middleware/roleGuard'

export const reportRoutes = new Elysia({ prefix: '/reports' })
  .use(tenantGuard)
  .use(requireRole(...ADMIN_ONLY))
