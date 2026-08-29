import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { checkDatabaseHealth, checkRedisHealth } from './modules/health/service'
import { authRoutes } from './modules/auth/routes'
import { tenantRoutes } from './modules/tenant/routes'
import { attendanceRoutes } from './modules/attendance/routes'
import { visitRoutes } from './modules/visit/routes'
import { orderRoutes } from './modules/order/routes'
import { materialRoutes, promotionRoutes } from './modules/material/routes'
import { customerRoutes } from './modules/customer/routes'
import { doctorRoutes } from './modules/doctor/routes'
import { liniRoutes, varianRoutes, userLiniRoutes } from './modules/lini/routes'
import { callPlanRoutes } from './modules/call-plan/routes'
import { reportRoutes } from './modules/report/routes'
import { erpSyncRoutes } from './modules/erp-sync/routes'

const port = process.env['PORT'] ?? 3000

const app = new Elysia()
  .use(cors())
  .use(swagger({
    documentation: {
      info: {
        title: 'KF Maction v2.0 API',
        version: '2.0.0',
        description: 'Sales Force Automation & Field Force Activity Monitoring',
      },
    },
  }))
  .use(authRoutes)
  .use(tenantRoutes)
  .use(attendanceRoutes)
  .use(visitRoutes)
  .use(orderRoutes)
  .use(materialRoutes)
  .use(promotionRoutes)
  .use(customerRoutes)
  .use(doctorRoutes)
  .use(liniRoutes)
  .use(varianRoutes)
  .use(userLiniRoutes)
  .use(callPlanRoutes)
  .use(reportRoutes)
  .use(erpSyncRoutes)
  .get('/health', async ({ set }) => {
    const [database, redis] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ])

    const status = database.status === 'down'
      ? 'unhealthy' as const
      : redis.status === 'down'
        ? 'degraded' as const
        : 'healthy' as const

    if (status === 'unhealthy') set.status = 503

    return { status, timestamp: new Date().toISOString(), version: '2.0.0', services: { database, redis } }
  })
  .listen(port)

console.log(`🚀 Maction API running at http://localhost:${port}`)

export type App = typeof app
