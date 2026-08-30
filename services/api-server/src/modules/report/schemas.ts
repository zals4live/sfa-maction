import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const RoleLabelSchema = Type.Union([Type.Literal('SALESMAN'), Type.Literal('MR')])

const FraudTypeSchema = Type.Union([
  Type.Literal('MOCK_LOCATION'),
  Type.Literal('VELOCITY_ANOMALY'),
  Type.Literal('ACCURACY_EXCESS'),
  Type.Literal('CLOCK_DRIFT'),
])

/** Per-role aggregate block reused across KPI and performance reports */
const RoleMetricsSchema = Type.Object({
  total_visits: Type.Integer({ description: 'Completed visits for this role' }),
  effective_calls: Type.Integer({ description: 'Visits fulfilling all mandatory activities' }),
  call_rate_pct: Type.Number({ description: 'Call rate percentage for this role' }),
})

// --- Request Schemas ---

/** GET /reports/dashboard-kpi — query params */
export const DashboardKpiQuery = Type.Object({
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by branch office' })),
  period: Type.Optional(
    Type.Union([Type.Literal('today'), Type.Literal('week'), Type.Literal('month')], {
      default: 'month',
      description: 'Aggregation period (relative window ending today)',
    })
  ),
})

/** GET /reports/branch-performance — query params */
export const BranchPerformanceQuery = Type.Object({
  month: Type.Integer({ minimum: 1, maximum: 12, description: 'Report month (1-12)' }),
  year: Type.Integer({ minimum: 2020, maximum: 2100, description: 'Report year' }),
})

/** GET /reports/call-rate — query params */
export const CallRateQuery = Type.Object({
  month: Type.Integer({ minimum: 1, maximum: 12, description: 'Report month (1-12)' }),
  year: Type.Integer({ minimum: 2020, maximum: 2100, description: 'Report year' }),
  user_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by specific user' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by branch office' })),
  role: Type.Optional(RoleLabelSchema),
})

/** GET /reports/orders — order/quotation register filters */
export const OrderRegisterQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  user_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by salesman' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by branch office' })),
  customer_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by customer' })),
  status: Type.Optional(
    Type.Union([
      Type.Literal('DRAFT'),
      Type.Literal('SUBMITTED'),
      Type.Literal('SYNCED_ERP'),
      Type.Literal('REJECTED_ERP'),
      Type.Literal('CANCELLED'),
    ])
  ),
  lini_id: Type.Optional(
    Type.String({ format: 'uuid', description: 'Filter by business line (via order items)' })
  ),
  date_from: Type.Optional(Type.String({ format: 'date', description: 'Start date (YYYY-MM-DD)' })),
  date_to: Type.Optional(Type.String({ format: 'date', description: 'End date (YYYY-MM-DD)' })),
  min_total: Type.Optional(
    Type.Number({ minimum: 0, description: 'Minimum grand total (inclusive)' })
  ),
  max_total: Type.Optional(
    Type.Number({ minimum: 0, description: 'Maximum grand total (inclusive)' })
  ),
})

/** GET /reports/fraud-incidents — query params */
export const FraudIncidentQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  user_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by specific user' })),
  fraud_type: Type.Optional(FraudTypeSchema),
  date_from: Type.Optional(Type.String({ format: 'date', description: 'Start date (YYYY-MM-DD)' })),
  date_to: Type.Optional(Type.String({ format: 'date', description: 'End date (YYYY-MM-DD)' })),
})

/** GET /reports/export/:type — path + query params */
export const ExportParams = Type.Object({
  type: Type.Union([Type.Literal('xlsx'), Type.Literal('pdf')], {
    description: 'Export file format',
  }),
})

export const ExportQuery = Type.Object({
  report: Type.Union([
    Type.Literal('dashboard-kpi'),
    Type.Literal('branch-performance'),
    Type.Literal('call-rate'),
    Type.Literal('orders'),
    Type.Literal('fraud-incidents'),
  ], { description: 'Which report to export' }),
  month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  year: Type.Optional(Type.Integer({ minimum: 2020, maximum: 2100 })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid' })),
})

// --- Response Schemas ---

/** GET /reports/dashboard-kpi — executive KPI segmented by role */
export const DashboardKpiResponse = Type.Object({
  data: Type.Object({
    period: Type.String(),
    total_active_users: Type.Integer(),
    total_orders: Type.Integer(),
    total_revenue: Type.Number(),
    SALESMAN: RoleMetricsSchema,
    MR: RoleMetricsSchema,
  }),
  meta: Type.Object({
    soffice_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    generated_at: Type.String({ format: 'date-time' }),
  }),
})

/** Single branch performance matrix row */
const BranchPerformanceRowSchema = Type.Object({
  soffice_id: Type.String({ format: 'uuid' }),
  soffice_name: Type.String(),
  rank: Type.Integer(),
  total_visits: Type.Integer(),
  total_revenue: Type.Number(),
  strike_rate_pct: Type.Number({ description: 'Orders per visit percentage' }),
  SALESMAN: RoleMetricsSchema,
  MR: RoleMetricsSchema,
})

/** GET /reports/branch-performance — branch ranking matrix */
export const BranchPerformanceResponse = Type.Object({
  data: Type.Array(BranchPerformanceRowSchema),
  meta: Type.Object({
    month: Type.Integer(),
    year: Type.Integer(),
    total_branches: Type.Integer(),
  }),
})

/** Single call-rate row per user */
const CallRateRowSchema = Type.Object({
  user_id: Type.String({ format: 'uuid' }),
  user_name: Type.String(),
  role_label: RoleLabelSchema,
  soffice_id: Type.String({ format: 'uuid' }),
  total_planned: Type.Integer(),
  total_visited: Type.Integer(),
  call_rate_pct: Type.Number(),
})

/** GET /reports/call-rate — call rate report */
export const CallRateReportResponse = Type.Object({
  data: Type.Array(CallRateRowSchema),
  meta: Type.Object({
    month: Type.Integer(),
    year: Type.Integer(),
    total_users: Type.Integer(),
  }),
})

/** Single order register row */
const OrderRegisterRowSchema = Type.Object({
  order_id: Type.String({ format: 'uuid' }),
  order_number: Type.String(),
  user_id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  status: Type.String(),
  total_amount: Type.Number(),
  created_at: Type.String({ format: 'date-time' }),
})

/** GET /reports/orders — paginated order register */
export const OrderRegisterResponse = Type.Object({
  data: Type.Array(OrderRegisterRowSchema),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Single fraud incident row */
const FraudIncidentRowSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  user_id: Type.String({ format: 'uuid' }),
  fraud_type: FraudTypeSchema,
  severity: Type.String(),
  claimed_lat: Type.Union([Type.Number(), Type.Null()]),
  claimed_lng: Type.Union([Type.Number(), Type.Null()]),
  calculated_speed_kmh: Type.Union([Type.Number(), Type.Null()]),
  action_taken: Type.String(),
  created_at: Type.String({ format: 'date-time' }),
})

/** GET /reports/fraud-incidents — paginated fraud telemetry */
export const FraudIncidentResponse = Type.Object({
  data: Type.Array(FraudIncidentRowSchema),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

// --- Static Types ---

export type DashboardKpiParams = Static<typeof DashboardKpiQuery>
export type BranchPerformanceParams = Static<typeof BranchPerformanceQuery>
export type CallRateParams = Static<typeof CallRateQuery>
export type OrderRegisterParams = Static<typeof OrderRegisterQuery>
export type FraudIncidentParams = Static<typeof FraudIncidentQuery>
export type ExportPathParams = Static<typeof ExportParams>
export type ExportQueryParams = Static<typeof ExportQuery>
export type DashboardKpiResponseType = Static<typeof DashboardKpiResponse>
export type BranchPerformanceResponseType = Static<typeof BranchPerformanceResponse>
export type CallRateReportResponseType = Static<typeof CallRateReportResponse>
export type OrderRegisterResponseType = Static<typeof OrderRegisterResponse>
export type FraudIncidentResponseType = Static<typeof FraudIncidentResponse>
