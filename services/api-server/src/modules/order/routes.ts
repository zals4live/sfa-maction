import { Elysia, t } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, SALESMAN_ONLY } from '../../middleware/roleGuard'

export const orderRoutes = new Elysia({ prefix: '/orders' })
  .use(tenantGuard)
  .use(requireRole(...SALESMAN_ONLY))
  .post('/', ({ claims }) => {
    return {
      data: {
        id: crypto.randomUUID(),
        company_id: claims!.company_id,
        user_id: claims!.user_id,
        status: 'DRAFT',
        items: [],
        created_at: new Date().toISOString(),
      },
    }
  })
  .get('/', ({ claims }) => {
    return {
      data: [],
      meta: { page: 1, limit: 20, total: 0 },
    }
  })
  .get('/:id', ({ params }) => {
    return {
      data: {
        id: params.id,
        status: 'DRAFT',
        items: [],
        sync_status: 'PENDING',
      },
    }
  }, { params: t.Object({ id: t.String() }) })
  .post('/:id/submit', ({ params }) => {
    return {
      data: {
        id: params.id,
        status: 'SUBMITTED',
        sync_status: 'QUEUED',
      },
    }
  }, { params: t.Object({ id: t.String() }) })
  .get('/:id/pdf', ({ params }) => {
    return {
      data: {
        id: params.id,
        pdf_url: `https://s3.example.com/orders/${params.id}/quotation.pdf`,
        expires_in: 3600,
      },
    }
  }, { params: t.Object({ id: t.String() }) })
