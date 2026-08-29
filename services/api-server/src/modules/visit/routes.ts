import { Elysia } from 'elysia'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, FIELD_FORCE } from '../../middleware/roleGuard'
import { attendanceLock } from '../../middleware/attendanceLock'
import {
  StartVisitBody,
  EndVisitBody,
  SignatureUploadUrlBody,
  ListVisitsQuery,
  VisitIdParams,
  AgendaIdParams,
  StockAuditIdParams,
  CompetitorAuditIdParams,
  CreateAgendaBody,
  UpdateAgendaBody,
  CreateStockAuditBody,
  UpdateStockAuditBody,
  CreateCompetitorAuditBody,
  UpdateCompetitorAuditBody,
} from './schemas'
import {
  startVisit,
  endVisit,
  generateSignatureUploadUrl,
  getVisitById,
  listVisits,
  createAgenda,
  updateAgenda,
  deleteAgenda,
  listAgendas,
  createStockAudit,
  updateStockAudit,
  deleteStockAudit,
  listStockAudits,
  createCompetitorAudit,
  updateCompetitorAudit,
  deleteCompetitorAudit,
  listCompetitorAudits,
  ServiceError,
} from './service'

/** Builds the VisitContext from JWT claims. */
function buildCtx(claims: { company_id: string; user_id: string; soffice_id: string; role_label: string }) {
  return {
    companyId: claims.company_id,
    userId: claims.user_id,
    sofficeId: claims.soffice_id,
    userRole: claims.role_label,
  }
}

export const visitRoutes = new Elysia({ prefix: '/visits' })
  .use(tenantGuard)
  .use(requireRole(...FIELD_FORCE))
  .use(attendanceLock)
  // --- Visit lifecycle ---
  .post(
    '/start',
    async ({ body, claims, set }) => {
      try {
        const result = await startVisit(body, buildCtx(claims!))
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
    { body: StartVisitBody }
  )
  .post(
    '/:id/end',
    async ({ params, body, claims, set }) => {
      try {
        const result = await endVisit(params.id, body, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: VisitIdParams, body: EndVisitBody }
  )
  .post(
    '/:id/signature-upload-url',
    async ({ params, body, claims, set }) => {
      try {
        const result = await generateSignatureUploadUrl(params.id, body, buildCtx(claims!))
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
    { params: VisitIdParams, body: SignatureUploadUrlBody }
  )
  // --- Visit queries ---
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await listVisits(query, buildCtx(claims!))
      return result
    },
    { query: ListVisitsQuery }
  )
  .get(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        const result = await getVisitById(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: VisitIdParams }
  )
  // --- Agenda sub-resource ---
  .post(
    '/:id/agendas',
    async ({ params, body, claims, set }) => {
      try {
        const result = await createAgenda(params.id, body, buildCtx(claims!))
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
    { params: VisitIdParams, body: CreateAgendaBody }
  )
  .patch(
    '/:id/agendas/:agendaId',
    async ({ params, body, claims, set }) => {
      try {
        const result = await updateAgenda(params.id, params.agendaId, body, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: AgendaIdParams, body: UpdateAgendaBody }
  )
  .delete(
    '/:id/agendas/:agendaId',
    async ({ params, claims, set }) => {
      try {
        await deleteAgenda(params.id, params.agendaId, buildCtx(claims!))
        set.status = 204
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: AgendaIdParams }
  )
  .get(
    '/:id/agendas',
    async ({ params, claims, set }) => {
      try {
        const result = await listAgendas(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: VisitIdParams }
  )
  // --- Stock audit sub-resource ---
  .post(
    '/:id/stock-audits',
    async ({ params, body, claims, set }) => {
      try {
        const result = await createStockAudit(params.id, body, buildCtx(claims!))
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
    { params: VisitIdParams, body: CreateStockAuditBody }
  )
  .patch(
    '/:id/stock-audits/:stockAuditId',
    async ({ params, body, claims, set }) => {
      try {
        const result = await updateStockAudit(params.id, params.stockAuditId, body, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: StockAuditIdParams, body: UpdateStockAuditBody }
  )
  .delete(
    '/:id/stock-audits/:stockAuditId',
    async ({ params, claims, set }) => {
      try {
        await deleteStockAudit(params.id, params.stockAuditId, buildCtx(claims!))
        set.status = 204
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: StockAuditIdParams }
  )
  .get(
    '/:id/stock-audits',
    async ({ params, claims, set }) => {
      try {
        const result = await listStockAudits(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: VisitIdParams }
  )
  // --- Competitor audit sub-resource ---
  .post(
    '/:id/competitor-audits',
    async ({ params, body, claims, set }) => {
      try {
        const result = await createCompetitorAudit(params.id, body, buildCtx(claims!))
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
    { params: VisitIdParams, body: CreateCompetitorAuditBody }
  )
  .patch(
    '/:id/competitor-audits/:competitorAuditId',
    async ({ params, body, claims, set }) => {
      try {
        const result = await updateCompetitorAudit(params.id, params.competitorAuditId, body, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CompetitorAuditIdParams, body: UpdateCompetitorAuditBody }
  )
  .delete(
    '/:id/competitor-audits/:competitorAuditId',
    async ({ params, claims, set }) => {
      try {
        await deleteCompetitorAudit(params.id, params.competitorAuditId, buildCtx(claims!))
        set.status = 204
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CompetitorAuditIdParams }
  )
  .get(
    '/:id/competitor-audits',
    async ({ params, claims, set }) => {
      try {
        const result = await listCompetitorAudits(params.id, buildCtx(claims!))
        return { data: result }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: VisitIdParams }
  )
