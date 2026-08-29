import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

const RoleLabelSchema = Type.Union([
  Type.Literal('SALESMAN'),
  Type.Literal('MR'),
])

// --- Request Schemas ---

/** Single plan item within a bulk upload */
const BulkPlanItemSchema = Type.Object({
  user_id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  outlet_context_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  plan_date: Type.String({ format: 'date', description: 'Planned visit date (YYYY-MM-DD)' }),
})

/** POST /call-plans/bulk-upload — request body */
export const BulkUploadCallPlanBody = Type.Object({
  plans: Type.Array(BulkPlanItemSchema, {
    minItems: 1,
    maxItems: 500,
    description: 'Array of visit plan entries for both Salesman and MR users',
  }),
})

/** GET /call-plans — pagination and filter query params */
export const ListCallPlansQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  user_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by specific user' })),
  month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: 'Filter by month (1-12)' })),
  year: Type.Optional(Type.Integer({ minimum: 2020, maximum: 2100, description: 'Filter by year' })),
  is_approved: Type.Optional(Type.Boolean({ description: 'Filter by approval status' })),
})

/** GET /call-plans/today — query params (admin override) */
export const TodayCallPlansQuery = Type.Object({
  user_id: Type.Optional(Type.String({ format: 'uuid', description: 'Override user for admin viewing' })),
})

/** GET /call-plans/analytics — query params */
export const CallPlanAnalyticsQuery = Type.Object({
  month: Type.Integer({ minimum: 1, maximum: 12, description: 'Report month (1-12)' }),
  year: Type.Integer({ minimum: 2020, maximum: 2100, description: 'Report year' }),
  user_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by specific user' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by branch office' })),
  role_filter: Type.Optional(RoleLabelSchema),
})

/** Path params with UUID id */
export const CallPlanIdParams = UUIDParamsSchema

// --- Response Schemas ---

/** Single call plan response object */
export const CallPlanResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  user_id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  outlet_context_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  plan_date: Type.String({ format: 'date' }),
  is_lead_from_erp: Type.Boolean(),
  is_approved: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
})

/** Paginated call plan list response */
export const CallPlanListResponse = Type.Object({
  data: Type.Array(CallPlanResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** GET /call-plans/today — today's plans response */
export const TodayCallPlansResponse = Type.Object({
  data: Type.Array(CallPlanResponse),
})

/** Bulk upload error detail */
const BulkUploadErrorSchema = Type.Object({
  index: Type.Integer({ description: 'Zero-based index of the failed plan in the input array' }),
  message: Type.String({ description: 'Human-readable error description' }),
})

/** POST /call-plans/bulk-upload — success response */
export const BulkUploadResponse = Type.Object({
  data: Type.Object({
    created: Type.Integer({ description: 'Number of plans successfully created' }),
    errors: Type.Array(BulkUploadErrorSchema),
  }),
})

/** Single user call rate analytics entry */
const CallRateEntrySchema = Type.Object({
  user_id: Type.String({ format: 'uuid' }),
  user_name: Type.String(),
  role_label: RoleLabelSchema,
  total_planned: Type.Integer({ description: 'Total planned visits for the period' }),
  total_visited: Type.Integer({ description: 'Actual completed visits' }),
  call_rate_pct: Type.Number({ description: 'Call rate percentage: (visited / planned) × 100' }),
})

/** Role-level aggregate call rate summary */
const RoleSummaryEntrySchema = Type.Object({
  total_planned: Type.Integer({ description: 'Total planned visits for all users in this role' }),
  total_visited: Type.Integer({ description: 'Total completed visits for all users in this role' }),
  call_rate_pct: Type.Number({ description: 'Aggregate call rate: (total_visited / total_planned) × 100' }),
})

/** GET /call-plans/analytics — analytics response */
export const CallPlanAnalyticsResponse = Type.Object({
  data: Type.Array(CallRateEntrySchema),
  summary: Type.Object({
    SALESMAN: RoleSummaryEntrySchema,
    MR: RoleSummaryEntrySchema,
  }),
  meta: Type.Object({
    month: Type.Integer(),
    year: Type.Integer(),
    total_users: Type.Integer(),
  }),
})

// --- Static Types ---

export type BulkUploadCallPlanInput = Static<typeof BulkUploadCallPlanBody>
export type ListCallPlansParams = Static<typeof ListCallPlansQuery>
export type TodayCallPlansParams = Static<typeof TodayCallPlansQuery>
export type CallPlanAnalyticsParams = Static<typeof CallPlanAnalyticsQuery>
export type CallPlanResponseType = Static<typeof CallPlanResponse>
export type CallPlanListResponseType = Static<typeof CallPlanListResponse>
export type TodayCallPlansResponseType = Static<typeof TodayCallPlansResponse>
export type BulkUploadResponseType = Static<typeof BulkUploadResponse>
export type CallPlanAnalyticsResponseType = Static<typeof CallPlanAnalyticsResponse>
