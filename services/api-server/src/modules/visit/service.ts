import { eq, and, sql, count, gte, lte, isNull } from 'drizzle-orm'

import { withRLS, resolveGeofenceTarget, type RLSContext, type Transaction } from '../../db'
import { generateUploadUrl, buildS3Key, type AllowedMimeType } from '../../config/s3'
import { visits, visitAgendas, visitStockAudits, visitCompetitorAudits } from '../../db/schema/visit'
import { companies } from '../../db/schema/tenant'
import { classifyVisitType } from '../call-plan/service'
import type {
  StartVisitInput,
  EndVisitInput,
  CreateAgendaInput,
  UpdateAgendaInput,
  CreateStockAuditInput,
  UpdateStockAuditInput,
  CreateCompetitorAuditInput,
  UpdateCompetitorAuditInput,
  ListVisitsParams,
  SignatureUploadUrlInput,
  SignatureUploadUrlResponseType,
  VisitResponseType,
  VisitDetailResponseType,
  AgendaResponseType,
  StockAuditResponseType,
  CompetitorAuditResponseType,
  VisitListResponseType,
} from './schemas'

/** Structured error thrown by service functions for route-level handling. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
  }
}

/** Context required for visit operations (derived from JWT claims). */
interface VisitContext {
  companyId: string
  userId: string
  sofficeId: string
  userRole: string
}

/** Formats today's date as YYYY-MM-DD. */
function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0]!
}

// =============================================================================
// Visit-In (Start Visit)
// =============================================================================

/** Start a new visit with geofence validation and concurrent lock enforcement. */
export async function startVisit(
  input: StartVisitInput,
  ctx: VisitContext
): Promise<VisitResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    await assertNoOpenVisit(tx, ctx.companyId, ctx.userId)

    const target = await resolveGeofenceTarget(tx, input.customer_id, input.outlet_id)
    const geofenceRadius = await getGeofenceRadius(tx, ctx.companyId)
    const { withinGeofence, distanceMeters } = await validateWithinGeofence(
      tx,
      input,
      target,
      geofenceRadius
    )

    if (!withinGeofence) {
      throw new ServiceError(
        'GEOFENCE_OUT_OF_RANGE',
        `You are ${distanceMeters ?? 0}m from the target location. Must be within ${geofenceRadius}m.`,
        403
      )
    }

    const visitDate = getTodayDateString()
    const visitType = await classifyVisitType(
      {
        companyId: ctx.companyId,
        userId: ctx.userId,
        customerId: input.customer_id,
        outletId: input.outlet_id ?? null,
        visitDate,
      },
      tx
    )

    const [row] = await tx
      .insert(visits)
      .values({
        companyId: ctx.companyId,
        userId: ctx.userId,
        customerId: input.customer_id,
        outletId: input.outlet_id ?? null,
        picId: input.pic_id ?? null,
        visitType,
        visitDate,
        visitInAt: new Date().toISOString(),
        visitInGeom: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)`,
        visitInDistanceMeters: distanceMeters,
        notes: input.notes ?? null,
        syncStatus: 'SYNCED',
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')

    return mapVisitRow(row, input.latitude, input.longitude)
  })
}

/** Ensures no open visit exists for the user today. Exported for testability. */
export async function assertNoOpenVisit(
  tx: Transaction,
  companyId: string,
  userId: string
): Promise<void> {
  const today = getTodayDateString()

  const [existing] = await tx
    .select({ id: visits.id })
    .from(visits)
    .where(
      and(
        eq(visits.companyId, companyId),
        eq(visits.userId, userId),
        eq(visits.visitDate, today),
        isNull(visits.visitOutAt)
      )
    )
    .limit(1)

  if (existing) {
    throw new ServiceError(
      'VISIT_ALREADY_OPEN',
      'You have an open visit that must be completed before starting a new one.',
      409
    )
  }
}

/** Result of geofence spatial validation using ST_DWithin + ST_DistanceSphere. */
interface GeofenceValidationResult {
  withinGeofence: boolean
  distanceMeters: number | null
}

/**
 * Validates whether the user's GPS position is within the geofence radius using
 * ST_DWithin (GiST index-friendly geography predicate) and calculates the actual
 * distance via ST_DistanceSphere for reporting purposes.
 */
async function validateWithinGeofence(
  tx: Transaction,
  input: { latitude: number; longitude: number },
  target: { latitude: number; longitude: number },
  radiusMeters: number
): Promise<GeofenceValidationResult> {
  const result = await tx.execute(
    sql`SELECT
      ST_DWithin(
        ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${target.longitude}, ${target.latitude}), 4326)::geography,
        ${radiusMeters}
      ) AS within_geofence,
      ST_DistanceSphere(
        ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326),
        ST_SetSRID(ST_MakePoint(${target.longitude}, ${target.latitude}), 4326)
      ) AS distance_meters`
  )

  const row = result[0] as { within_geofence: boolean; distance_meters: number } | undefined

  return {
    withinGeofence: row?.within_geofence ?? false,
    distanceMeters: row?.distance_meters != null ? Math.round(row.distance_meters) : null,
  }
}

/** Retrieves the company's configured geofence radius. */
async function getGeofenceRadius(
  tx: Transaction,
  companyId: string
): Promise<number> {
  const [company] = await tx
    .select({ geofenceRadiusMeters: companies.geofenceRadiusMeters })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)

  return company?.geofenceRadiusMeters ?? 100
}

// =============================================================================
// Visit-Out (End Visit)
// =============================================================================

/** End an active visit with GPS out, signature, and timestamp. */
export async function endVisit(
  visitId: string,
  input: EndVisitInput,
  ctx: VisitContext
): Promise<VisitResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const visit = await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    if (visit.visitOutAt) {
      throw new ServiceError(
        'VISIT_ALREADY_ENDED',
        'This visit has already been completed.',
        409
      )
    }

    const [updated] = await tx
      .update(visits)
      .set({
        visitOutAt: new Date().toISOString(),
        visitOutGeom: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)`,
        signatureS3Key: input.signature_s3_key,
        notes: input.notes ?? visit.notes,
      })
      .where(eq(visits.id, visitId))
      .returning()

    if (!updated) throw new Error('Update returned no rows')

    return mapVisitRowWithGeom(tx, updated)
  })
}

// =============================================================================
// Signature Upload URL (Pre-signed S3 PUT)
// =============================================================================

/** Data returned to the client for a signature pre-signed upload. */
type SignatureUploadUrlData = SignatureUploadUrlResponseType['data']

/** MIME type to file extension mapping for signature uploads (PNG canvas export). */
const SIGNATURE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
}

const SIGNATURE_UPLOAD_URL_EXPIRY_SECONDS = 900

/**
 * Generates a pre-signed S3 PUT URL for a visit signature image. Ownership of the
 * target visit is verified first so a user cannot mint upload URLs for visits they
 * do not own. The returned `s3_key` is later submitted as `signature_s3_key` on
 * the visit-out call — binary data never flows through the API server.
 */
export async function generateSignatureUploadUrl(
  visitId: string,
  input: SignatureUploadUrlInput,
  ctx: VisitContext
): Promise<SignatureUploadUrlData> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const visit = await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    if (visit.visitOutAt) {
      throw new ServiceError(
        'VISIT_ALREADY_ENDED',
        'This visit has already been completed.',
        409
      )
    }

    const fileId = crypto.randomUUID()
    const extension = SIGNATURE_MIME_TO_EXT[input.content_type] ?? 'png'

    const s3Key = buildS3Key({
      companyId: ctx.companyId,
      category: 'visits/signatures',
      fileId,
      extension,
    })

    const uploadUrl = await generateUploadUrl({
      key: s3Key,
      contentType: input.content_type as AllowedMimeType,
      expiresIn: SIGNATURE_UPLOAD_URL_EXPIRY_SECONDS,
    })

    return {
      upload_url: uploadUrl,
      s3_key: s3Key,
      expires_in: SIGNATURE_UPLOAD_URL_EXPIRY_SECONDS,
    }
  })
}

// =============================================================================
// Visit Detail & List
// =============================================================================

/** Fetch a single visit with nested sub-resources. */
export async function getVisitById(
  visitId: string,
  ctx: VisitContext
): Promise<VisitDetailResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const visit = await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)
    const visitResponse = await mapVisitRowWithGeom(tx, visit)

    const [agendas, stockAudits, competitorAudits] = await Promise.all([
      fetchAgendas(tx, visitId),
      fetchStockAudits(tx, visitId),
      fetchCompetitorAudits(tx, visitId),
    ])

    return { ...visitResponse, agendas, stock_audits: stockAudits, competitor_audits: competitorAudits }
  })
}

/** Paginated visit list with optional filters. */
export async function listVisits(
  params: ListVisitsParams,
  ctx: VisitContext
): Promise<VisitListResponseType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  return withRLS(rlsCtx, async (tx) => {
    const conditions = buildListConditions(params, ctx)
    const whereClause = and(...conditions)

    const [rows, totalResult] = await Promise.all([
      tx
        .select()
        .from(visits)
        .where(whereClause)
        .orderBy(sql`${visits.visitInAt} DESC`)
        .limit(limit)
        .offset(offset),
      tx
        .select({ total: count() })
        .from(visits)
        .where(whereClause),
    ])

    const data = await Promise.all(rows.map((row) => mapVisitRowWithGeom(tx, row)))

    return { data, meta: { page, limit, total: totalResult[0]?.total ?? 0 } }
  })
}

/** Builds WHERE conditions for the visit list query. */
function buildListConditions(params: ListVisitsParams, ctx: VisitContext) {
  const conditions = [
    eq(visits.companyId, ctx.companyId),
    eq(visits.userId, ctx.userId),
  ]

  if (params.start_date) conditions.push(gte(visits.visitDate, params.start_date))
  if (params.end_date) conditions.push(lte(visits.visitDate, params.end_date))
  if (params.customer_id) conditions.push(eq(visits.customerId, params.customer_id))
  if (params.visit_type) conditions.push(eq(visits.visitType, params.visit_type))

  return conditions
}

// =============================================================================
// Agenda CRUD
// =============================================================================

/** Create a detailing agenda for an active visit. */
export async function createAgenda(
  visitId: string,
  input: CreateAgendaInput,
  ctx: VisitContext
): Promise<AgendaResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const [row] = await tx
      .insert(visitAgendas)
      .values({
        visitId,
        topic: input.topic,
        productDiscussedId: input.product_discussed_id ?? null,
        discussionSummary: input.discussion_summary ?? null,
        photoS3Key: input.photo_s3_key ?? null,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapAgendaRow(row)
  })
}

/** Update an existing agenda record. */
export async function updateAgenda(
  visitId: string,
  agendaId: string,
  input: UpdateAgendaInput,
  ctx: VisitContext
): Promise<AgendaResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const updates: Record<string, unknown> = {}
    if (input.topic !== undefined) updates.topic = input.topic
    if (input.product_discussed_id !== undefined) updates.productDiscussedId = input.product_discussed_id
    if (input.discussion_summary !== undefined) updates.discussionSummary = input.discussion_summary
    if (input.photo_s3_key !== undefined) updates.photoS3Key = input.photo_s3_key

    const [row] = await tx
      .update(visitAgendas)
      .set(updates)
      .where(and(eq(visitAgendas.id, agendaId), eq(visitAgendas.visitId, visitId)))
      .returning()

    if (!row) throw new ServiceError('AGENDA_NOT_FOUND', 'Agenda not found', 404)
    return mapAgendaRow(row)
  })
}

/** Delete an agenda record. */
export async function deleteAgenda(
  visitId: string,
  agendaId: string,
  ctx: VisitContext
): Promise<void> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const result = await tx
      .delete(visitAgendas)
      .where(and(eq(visitAgendas.id, agendaId), eq(visitAgendas.visitId, visitId)))
      .returning({ id: visitAgendas.id })

    if (result.length === 0) throw new ServiceError('AGENDA_NOT_FOUND', 'Agenda not found', 404)
  })
}

/** List all agendas for a visit. */
export async function listAgendas(
  visitId: string,
  ctx: VisitContext
): Promise<AgendaResponseType[]> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)
    return fetchAgendas(tx, visitId)
  })
}

// =============================================================================
// Stock Audit CRUD
// =============================================================================

/** Create a stock audit entry for a visit. */
export async function createStockAudit(
  visitId: string,
  input: CreateStockAuditInput,
  ctx: VisitContext
): Promise<StockAuditResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const [row] = await tx
      .insert(visitStockAudits)
      .values({
        visitId,
        materialId: input.material_id,
        physicalStockQty: input.physical_stock_qty,
        uom: input.uom,
        estimatedDaysOfStock: input.estimated_days_of_stock ?? null,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapStockAuditRow(row)
  })
}

/** Update an existing stock audit. */
export async function updateStockAudit(
  visitId: string,
  stockAuditId: string,
  input: UpdateStockAuditInput,
  ctx: VisitContext
): Promise<StockAuditResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const updates: Record<string, unknown> = {}
    if (input.material_id !== undefined) updates.materialId = input.material_id
    if (input.physical_stock_qty !== undefined) updates.physicalStockQty = input.physical_stock_qty
    if (input.uom !== undefined) updates.uom = input.uom
    if (input.estimated_days_of_stock !== undefined) updates.estimatedDaysOfStock = input.estimated_days_of_stock

    const [row] = await tx
      .update(visitStockAudits)
      .set(updates)
      .where(and(eq(visitStockAudits.id, stockAuditId), eq(visitStockAudits.visitId, visitId)))
      .returning()

    if (!row) throw new ServiceError('STOCK_AUDIT_NOT_FOUND', 'Stock audit not found', 404)
    return mapStockAuditRow(row)
  })
}

/** Delete a stock audit record. */
export async function deleteStockAudit(
  visitId: string,
  stockAuditId: string,
  ctx: VisitContext
): Promise<void> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const result = await tx
      .delete(visitStockAudits)
      .where(and(eq(visitStockAudits.id, stockAuditId), eq(visitStockAudits.visitId, visitId)))
      .returning({ id: visitStockAudits.id })

    if (result.length === 0) throw new ServiceError('STOCK_AUDIT_NOT_FOUND', 'Stock audit not found', 404)
  })
}

/** List all stock audits for a visit. */
export async function listStockAudits(
  visitId: string,
  ctx: VisitContext
): Promise<StockAuditResponseType[]> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)
    return fetchStockAudits(tx, visitId)
  })
}

// =============================================================================
// Competitor Audit CRUD
// =============================================================================

/** Create a competitor audit entry for a visit. */
export async function createCompetitorAudit(
  visitId: string,
  input: CreateCompetitorAuditInput,
  ctx: VisitContext
): Promise<CompetitorAuditResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const [row] = await tx
      .insert(visitCompetitorAudits)
      .values({
        visitId,
        competitorBrand: input.competitor_brand,
        competitorProduct: input.competitor_product,
        priceToPharmacy: input.price_to_pharmacy != null ? String(input.price_to_pharmacy) : null,
        consumerPrice: input.consumer_price != null ? String(input.consumer_price) : null,
        activePromoNotes: input.active_promo_notes ?? null,
        photoS3Key: input.photo_s3_key ?? null,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapCompetitorAuditRow(row)
  })
}

/** Update an existing competitor audit. */
export async function updateCompetitorAudit(
  visitId: string,
  competitorAuditId: string,
  input: UpdateCompetitorAuditInput,
  ctx: VisitContext
): Promise<CompetitorAuditResponseType> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const updates: Record<string, unknown> = {}
    if (input.competitor_brand !== undefined) updates.competitorBrand = input.competitor_brand
    if (input.competitor_product !== undefined) updates.competitorProduct = input.competitor_product
    if (input.price_to_pharmacy !== undefined) updates.priceToPharmacy = input.price_to_pharmacy != null ? String(input.price_to_pharmacy) : null
    if (input.consumer_price !== undefined) updates.consumerPrice = input.consumer_price != null ? String(input.consumer_price) : null
    if (input.active_promo_notes !== undefined) updates.activePromoNotes = input.active_promo_notes
    if (input.photo_s3_key !== undefined) updates.photoS3Key = input.photo_s3_key

    const [row] = await tx
      .update(visitCompetitorAudits)
      .set(updates)
      .where(and(eq(visitCompetitorAudits.id, competitorAuditId), eq(visitCompetitorAudits.visitId, visitId)))
      .returning()

    if (!row) throw new ServiceError('COMPETITOR_AUDIT_NOT_FOUND', 'Competitor audit not found', 404)
    return mapCompetitorAuditRow(row)
  })
}

/** Delete a competitor audit record. */
export async function deleteCompetitorAudit(
  visitId: string,
  competitorAuditId: string,
  ctx: VisitContext
): Promise<void> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)

    const result = await tx
      .delete(visitCompetitorAudits)
      .where(and(eq(visitCompetitorAudits.id, competitorAuditId), eq(visitCompetitorAudits.visitId, visitId)))
      .returning({ id: visitCompetitorAudits.id })

    if (result.length === 0) throw new ServiceError('COMPETITOR_AUDIT_NOT_FOUND', 'Competitor audit not found', 404)
  })
}

/** List all competitor audits for a visit. */
export async function listCompetitorAudits(
  visitId: string,
  ctx: VisitContext
): Promise<CompetitorAuditResponseType[]> {
  const rlsCtx: RLSContext = { companyId: ctx.companyId, userId: ctx.userId, userRole: ctx.userRole }

  return withRLS(rlsCtx, async (tx) => {
    await fetchOwnedVisit(tx, visitId, ctx.userId, ctx.companyId)
    return fetchCompetitorAudits(tx, visitId)
  })
}

// =============================================================================
// Internal Helpers
// =============================================================================

/** Fetches a visit and verifies ownership. Throws if not found or unauthorized. */
async function fetchOwnedVisit(
  tx: Transaction,
  visitId: string,
  userId: string,
  companyId: string
): Promise<typeof visits.$inferSelect> {
  const [visit] = await tx
    .select()
    .from(visits)
    .where(and(eq(visits.id, visitId), eq(visits.companyId, companyId)))
    .limit(1)

  if (!visit) {
    throw new ServiceError('VISIT_NOT_FOUND', 'Visit not found', 404)
  }

  if (visit.userId !== userId) {
    throw new ServiceError('VISIT_NOT_OWNED', 'You do not have access to this visit', 403)
  }

  return visit
}

/** Extracts lat/lng from a visit row's geometry columns via PostGIS. */
async function mapVisitRowWithGeom(
  tx: Transaction,
  row: typeof visits.$inferSelect
): Promise<VisitResponseType> {
  const result = await tx.execute(
    sql`SELECT
      ST_Y(${sql.raw(`'${row.visitInGeom}'::geometry`)}) AS visit_in_lat,
      ST_X(${sql.raw(`'${row.visitInGeom}'::geometry`)}) AS visit_in_lng,
      CASE WHEN ${row.visitOutGeom} IS NOT NULL
        THEN ST_Y(${sql.raw(`'${row.visitOutGeom}'::geometry`)})
        ELSE NULL END AS visit_out_lat,
      CASE WHEN ${row.visitOutGeom} IS NOT NULL
        THEN ST_X(${sql.raw(`'${row.visitOutGeom}'::geometry`)})
        ELSE NULL END AS visit_out_lng`
  )

  const geom = result[0] as {
    visit_in_lat: number
    visit_in_lng: number
    visit_out_lat: number | null
    visit_out_lng: number | null
  } | undefined

  return {
    id: row.id,
    company_id: row.companyId,
    user_id: row.userId,
    customer_id: row.customerId,
    outlet_id: row.outletId ?? null,
    pic_id: row.picId ?? null,
    visit_type: row.visitType as 'PLANNED' | 'EXTRA',
    visit_date: row.visitDate,
    visit_in_at: row.visitInAt,
    visit_in_latitude: geom?.visit_in_lat ?? 0,
    visit_in_longitude: geom?.visit_in_lng ?? 0,
    visit_in_distance_meters: row.visitInDistanceMeters ?? null,
    visit_out_at: row.visitOutAt ?? null,
    visit_out_latitude: geom?.visit_out_lat ?? null,
    visit_out_longitude: geom?.visit_out_lng ?? null,
    signature_s3_key: row.signatureS3Key ?? null,
    notes: row.notes ?? null,
    sync_status: row.syncStatus as 'PENDING' | 'SYNCED' | 'FAILED',
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/** Maps a freshly inserted visit row when we already know the coordinates. */
function mapVisitRow(
  row: typeof visits.$inferSelect,
  inLatitude: number,
  inLongitude: number
): VisitResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    user_id: row.userId,
    customer_id: row.customerId,
    outlet_id: row.outletId ?? null,
    pic_id: row.picId ?? null,
    visit_type: row.visitType as 'PLANNED' | 'EXTRA',
    visit_date: row.visitDate,
    visit_in_at: row.visitInAt,
    visit_in_latitude: inLatitude,
    visit_in_longitude: inLongitude,
    visit_in_distance_meters: row.visitInDistanceMeters ?? null,
    visit_out_at: row.visitOutAt ?? null,
    visit_out_latitude: null,
    visit_out_longitude: null,
    signature_s3_key: row.signatureS3Key ?? null,
    notes: row.notes ?? null,
    sync_status: row.syncStatus as 'PENDING' | 'SYNCED' | 'FAILED',
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/** Fetches agendas for a visit and maps to response type. */
async function fetchAgendas(tx: Transaction, visitId: string): Promise<AgendaResponseType[]> {
  const rows = await tx
    .select()
    .from(visitAgendas)
    .where(eq(visitAgendas.visitId, visitId))
    .orderBy(sql`${visitAgendas.createdAt} ASC`)

  return rows.map(mapAgendaRow)
}

/** Maps an agenda Drizzle row to the API response shape. */
function mapAgendaRow(row: typeof visitAgendas.$inferSelect): AgendaResponseType {
  return {
    id: row.id,
    visit_id: row.visitId,
    topic: row.topic,
    product_discussed_id: row.productDiscussedId ?? null,
    discussion_summary: row.discussionSummary ?? null,
    photo_s3_key: row.photoS3Key ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/** Fetches stock audits for a visit. */
async function fetchStockAudits(tx: Transaction, visitId: string): Promise<StockAuditResponseType[]> {
  const rows = await tx
    .select()
    .from(visitStockAudits)
    .where(eq(visitStockAudits.visitId, visitId))
    .orderBy(sql`${visitStockAudits.createdAt} ASC`)

  return rows.map(mapStockAuditRow)
}

/** Maps a stock audit row to API response shape. */
function mapStockAuditRow(row: typeof visitStockAudits.$inferSelect): StockAuditResponseType {
  return {
    id: row.id,
    visit_id: row.visitId,
    material_id: row.materialId,
    physical_stock_qty: row.physicalStockQty,
    uom: row.uom,
    estimated_days_of_stock: row.estimatedDaysOfStock ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/** Fetches competitor audits for a visit. */
async function fetchCompetitorAudits(tx: Transaction, visitId: string): Promise<CompetitorAuditResponseType[]> {
  const rows = await tx
    .select()
    .from(visitCompetitorAudits)
    .where(eq(visitCompetitorAudits.visitId, visitId))
    .orderBy(sql`${visitCompetitorAudits.createdAt} ASC`)

  return rows.map(mapCompetitorAuditRow)
}

/** Maps a competitor audit row to API response shape. */
function mapCompetitorAuditRow(row: typeof visitCompetitorAudits.$inferSelect): CompetitorAuditResponseType {
  return {
    id: row.id,
    visit_id: row.visitId,
    competitor_brand: row.competitorBrand,
    competitor_product: row.competitorProduct,
    price_to_pharmacy: row.priceToPharmacy ? Number(row.priceToPharmacy) : null,
    consumer_price: row.consumerPrice ? Number(row.consumerPrice) : null,
    active_promo_notes: row.activePromoNotes ?? null,
    photo_s3_key: row.photoS3Key ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}
