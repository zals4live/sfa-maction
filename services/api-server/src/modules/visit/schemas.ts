import { Type, type Static } from '@sinclair/typebox'

// --- Enum Schemas ---

const visitTypes = ['PLANNED', 'EXTRA'] as const
const syncStatuses = ['PENDING', 'SYNCED', 'FAILED'] as const

export const VisitTypeSchema = Type.Union(
  visitTypes.map((v) => Type.Literal(v)),
  { description: 'Visit type discriminator' }
)

export const SyncStatusSchema = Type.Union(
  syncStatuses.map((v) => Type.Literal(v)),
  { description: 'Sync status for offline mutations' }
)

// --- Shared Schema Fragments ---

const AntiSpoofFieldsSchema = {
  monotonic_delta_ms: Type.Number({ description: 'performance.now() hardware clock delta in milliseconds' }),
  client_timestamp: Type.String({ format: 'date-time', description: 'ISO 8601 client-side timestamp for clock drift detection' }),
}

const GpsFieldsSchema = {
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracy: Type.Number({ minimum: 3, maximum: 50, description: 'GPS accuracy in meters (3m–50m valid range per anti-spoofing policy)' }),
}

// --- Path Params ---

export const VisitIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

export const AgendaIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  agendaId: Type.String({ format: 'uuid' }),
})

export const StockAuditIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  stockAuditId: Type.String({ format: 'uuid' }),
})

export const CompetitorAuditIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  competitorAuditId: Type.String({ format: 'uuid' }),
})

// --- Request Schemas ---

/** POST /visits/start — start a new visit (visit-in) */
export const StartVisitBody = Type.Object({
  customer_id: Type.String({ format: 'uuid' }),
  outlet_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  pic_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  ...GpsFieldsSchema,
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ...AntiSpoofFieldsSchema,
})

/** POST /visits/:id/end — end an active visit (visit-out) */
export const EndVisitBody = Type.Object({
  ...GpsFieldsSchema,
  signature_s3_key: Type.String({ minLength: 1, description: 'S3 key of captured digital signature' }),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ...AntiSpoofFieldsSchema,
})

/** POST /visits/:id/agendas — create a detailing agenda */
export const CreateAgendaBody = Type.Object({
  topic: Type.String({ minLength: 1, maxLength: 255 }),
  product_discussed_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  discussion_summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  photo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/** PATCH /visits/:id/agendas/:agendaId — update an agenda */
export const UpdateAgendaBody = Type.Object({
  topic: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  product_discussed_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  discussion_summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  photo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/** POST /visits/:id/stock-audits — create a stock audit */
export const CreateStockAuditBody = Type.Object({
  material_id: Type.String({ format: 'uuid' }),
  physical_stock_qty: Type.Integer({ minimum: 0 }),
  uom: Type.String({ minLength: 1, maxLength: 20 }),
  estimated_days_of_stock: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
})

/** PATCH /visits/:id/stock-audits/:stockAuditId — update a stock audit */
export const UpdateStockAuditBody = Type.Object({
  material_id: Type.Optional(Type.String({ format: 'uuid' })),
  physical_stock_qty: Type.Optional(Type.Integer({ minimum: 0 })),
  uom: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
  estimated_days_of_stock: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
})

/** POST /visits/:id/competitor-audits — create a competitor audit */
export const CreateCompetitorAuditBody = Type.Object({
  competitor_brand: Type.String({ minLength: 1, maxLength: 150 }),
  competitor_product: Type.String({ minLength: 1, maxLength: 150 }),
  price_to_pharmacy: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  consumer_price: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  active_promo_notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  photo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/** PATCH /visits/:id/competitor-audits/:competitorAuditId — update a competitor audit */
export const UpdateCompetitorAuditBody = Type.Object({
  competitor_brand: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
  competitor_product: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
  price_to_pharmacy: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  consumer_price: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  active_promo_notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  photo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

// --- Signature Upload URL Schemas ---

const signatureImageMimeTypes = ['image/png'] as const

/** POST /visits/:id/signature-upload-url — request a pre-signed URL for the signature image */
export const SignatureUploadUrlBody = Type.Object({
  content_type: Type.Union(
    signatureImageMimeTypes.map((v) => Type.Literal(v)),
    { description: 'MIME type for signature canvas export (image/png only)' }
  ),
})

/** POST /visits/:id/signature-upload-url — pre-signed URL response */
export const SignatureUploadUrlResponse = Type.Object({
  data: Type.Object({
    upload_url: Type.String({ description: 'Pre-signed S3 PUT URL for the signature image' }),
    s3_key: Type.String({ description: 'S3 object key to reference on visit-out' }),
    expires_in: Type.Integer({ description: 'URL expiry in seconds' }),
  }),
})

/** GET /visits — paginated visit list with filters */
export const ListVisitsQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  start_date: Type.Optional(Type.String({ format: 'date', description: 'Filter start date (YYYY-MM-DD)' })),
  end_date: Type.Optional(Type.String({ format: 'date', description: 'Filter end date (YYYY-MM-DD)' })),
  customer_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by customer' })),
  visit_type: Type.Optional(VisitTypeSchema),
})

// --- Response Schemas ---

/** Single visit record */
export const VisitResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  user_id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  outlet_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  pic_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  visit_type: VisitTypeSchema,
  visit_date: Type.String({ format: 'date' }),
  visit_in_at: Type.String({ format: 'date-time' }),
  visit_in_latitude: Type.Number(),
  visit_in_longitude: Type.Number(),
  visit_in_distance_meters: Type.Union([Type.Integer(), Type.Null()]),
  visit_out_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  visit_out_latitude: Type.Union([Type.Number(), Type.Null()]),
  visit_out_longitude: Type.Union([Type.Number(), Type.Null()]),
  signature_s3_key: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  sync_status: SyncStatusSchema,
  created_at: Type.String({ format: 'date-time' }),
})

/** Single agenda record */
export const AgendaResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  visit_id: Type.String({ format: 'uuid' }),
  topic: Type.String(),
  product_discussed_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  discussion_summary: Type.Union([Type.String(), Type.Null()]),
  photo_s3_key: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
})

/** Single stock audit record */
export const StockAuditResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  visit_id: Type.String({ format: 'uuid' }),
  material_id: Type.String({ format: 'uuid' }),
  physical_stock_qty: Type.Integer(),
  uom: Type.String(),
  estimated_days_of_stock: Type.Union([Type.Integer(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
})

/** Single competitor audit record */
export const CompetitorAuditResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  visit_id: Type.String({ format: 'uuid' }),
  competitor_brand: Type.String(),
  competitor_product: Type.String(),
  price_to_pharmacy: Type.Union([Type.Number(), Type.Null()]),
  consumer_price: Type.Union([Type.Number(), Type.Null()]),
  active_promo_notes: Type.Union([Type.String(), Type.Null()]),
  photo_s3_key: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
})

/** Visit detail response — visit with nested sub-resources */
export const VisitDetailResponse = Type.Object({
  ...VisitResponse.properties,
  agendas: Type.Array(AgendaResponse),
  stock_audits: Type.Array(StockAuditResponse),
  competitor_audits: Type.Array(CompetitorAuditResponse),
})

/** Paginated visit list response */
export const VisitListResponse = Type.Object({
  data: Type.Array(VisitResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Visit mutation response */
export const VisitMutationResponse = Type.Object({
  data: VisitResponse,
})

/** Visit detail mutation response */
export const VisitDetailMutationResponse = Type.Object({
  data: VisitDetailResponse,
})

/** Agenda mutation response */
export const AgendaMutationResponse = Type.Object({
  data: AgendaResponse,
})

/** Agenda list response */
export const AgendaListResponse = Type.Object({
  data: Type.Array(AgendaResponse),
})

/** Stock audit mutation response */
export const StockAuditMutationResponse = Type.Object({
  data: StockAuditResponse,
})

/** Stock audit list response */
export const StockAuditListResponse = Type.Object({
  data: Type.Array(StockAuditResponse),
})

/** Competitor audit mutation response */
export const CompetitorAuditMutationResponse = Type.Object({
  data: CompetitorAuditResponse,
})

/** Competitor audit list response */
export const CompetitorAuditListResponse = Type.Object({
  data: Type.Array(CompetitorAuditResponse),
})

// --- Static Types ---

export type StartVisitInput = Static<typeof StartVisitBody>
export type EndVisitInput = Static<typeof EndVisitBody>
export type CreateAgendaInput = Static<typeof CreateAgendaBody>
export type UpdateAgendaInput = Static<typeof UpdateAgendaBody>
export type CreateStockAuditInput = Static<typeof CreateStockAuditBody>
export type UpdateStockAuditInput = Static<typeof UpdateStockAuditBody>
export type CreateCompetitorAuditInput = Static<typeof CreateCompetitorAuditBody>
export type UpdateCompetitorAuditInput = Static<typeof UpdateCompetitorAuditBody>
export type ListVisitsParams = Static<typeof ListVisitsQuery>
export type SignatureUploadUrlInput = Static<typeof SignatureUploadUrlBody>
export type SignatureUploadUrlResponseType = Static<typeof SignatureUploadUrlResponse>

export type VisitResponseType = Static<typeof VisitResponse>
export type VisitDetailResponseType = Static<typeof VisitDetailResponse>
export type AgendaResponseType = Static<typeof AgendaResponse>
export type StockAuditResponseType = Static<typeof StockAuditResponse>
export type CompetitorAuditResponseType = Static<typeof CompetitorAuditResponse>
export type VisitListResponseType = Static<typeof VisitListResponse>
export type VisitMutationResponseType = Static<typeof VisitMutationResponse>
export type VisitDetailMutationResponseType = Static<typeof VisitDetailMutationResponse>
export type AgendaMutationResponseType = Static<typeof AgendaMutationResponse>
export type AgendaListResponseType = Static<typeof AgendaListResponse>
export type StockAuditMutationResponseType = Static<typeof StockAuditMutationResponse>
export type StockAuditListResponseType = Static<typeof StockAuditListResponse>
export type CompetitorAuditMutationResponseType = Static<typeof CompetitorAuditMutationResponse>
export type CompetitorAuditListResponseType = Static<typeof CompetitorAuditListResponse>
