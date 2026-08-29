import { Type, type Static } from '@sinclair/typebox'
import { OrderStatus } from '@maction/types'

// --- Enum Schemas ---

/** Order lifecycle status — mirrors PostgreSQL order_status_enum and @maction/types OrderStatus */
export const OrderStatusSchema = Type.Union(
  Object.values(OrderStatus).map((v) => Type.Literal(v)),
  { description: 'Order lifecycle status' }
)

const orderChannels = ['ON_SITE', 'BY_PHONE'] as const

/** Order channel — on-site (during a visit) or by-phone (remote) */
export const OrderChannelSchema = Type.Union(
  orderChannels.map((v) => Type.Literal(v)),
  { description: 'Order channel: ON_SITE (during a visit) or BY_PHONE (remote)' }
)

// --- Shared Schema Fragments ---

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

// --- Path Params ---

/** Path params with UUID id (used by :id, :id/submit, :id/pdf routes) */
export const OrderIdParams = UUIDParamsSchema

// --- Request Schemas ---

/** A single order line item in the create-order request */
export const CreateOrderItemBody = Type.Object({
  material_id: Type.String({ format: 'uuid' }),
  varian_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  qty: Type.Integer({ minimum: 1, description: 'Order quantity in the selected UOM (must be greater than 0)' }),
  uom: Type.String({ minLength: 1, maxLength: 20, description: 'Unit of measure (e.g., PCS, STRIP, BOX, KARTON)' }),
  discount_percentage: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, description: 'Line-item discount percentage (0–100)' })
  ),
  promotion_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
})

/** POST /orders — create a new order (Salesman only), supports on-site and by-phone */
export const CreateOrderBody = Type.Object({
  order_channel: OrderChannelSchema,
  customer_id: Type.String({ format: 'uuid' }),
  doctor_customer_id: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  visit_id: Type.Optional(
    Type.Union([Type.String({ format: 'uuid' }), Type.Null()], {
      description: 'Reference to the originating visit — required for ON_SITE, optional for BY_PHONE',
    })
  ),
  items: Type.Array(CreateOrderItemBody, {
    minItems: 1,
    description: 'Order line items (at least one required)',
  }),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/** POST /orders/:id/submit — submit an order for ERP sync (path param only) */
export const SubmitOrderParams = UUIDParamsSchema

/** GET /orders — paginated order list with filters */
export const ListOrdersQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  status: Type.Optional(OrderStatusSchema),
  date_from: Type.Optional(Type.String({ format: 'date', description: 'Filter orders from this date (YYYY-MM-DD)' })),
  date_to: Type.Optional(Type.String({ format: 'date', description: 'Filter orders up to this date (YYYY-MM-DD)' })),
  customer_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by customer' })),
})

// --- Response Schemas ---

/** Single order line item record */
export const OrderItemResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  order_id: Type.String({ format: 'uuid' }),
  material_id: Type.String({ format: 'uuid' }),
  qty: Type.Integer(),
  uom: Type.String(),
  unit_price: Type.Number(),
  discount_percentage: Type.Number(),
  discount_amount: Type.Number(),
  subtotal: Type.Number(),
  promotion_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  is_free_goods: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
})

/** Single order header record */
export const OrderResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  user_id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  doctor_customer_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  visit_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  order_number: Type.String(),
  erp_quotation_number: Type.Union([Type.String(), Type.Null()]),
  order_date: Type.String({ format: 'date' }),
  subtotal_amount: Type.Number(),
  total_discount_amount: Type.Number(),
  tax_rate: Type.Number(),
  tax_amount: Type.Number(),
  grand_total: Type.Number(),
  order_status: OrderStatusSchema,
  erp_sync_timestamp: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  pdf_quotation_s3_key: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** Order detail response — header with nested line items */
export const OrderDetailResponse = Type.Object({
  ...OrderResponse.properties,
  items: Type.Array(OrderItemResponse),
})

/** Paginated order list response */
export const OrderListResponse = Type.Object({
  data: Type.Array(OrderResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Order mutation response (create/submit) */
export const OrderMutationResponse = Type.Object({
  data: OrderResponse,
})

/** Order detail mutation response (with nested items) */
export const OrderDetailMutationResponse = Type.Object({
  data: OrderDetailResponse,
})

/** GET /orders/:id/pdf — pre-signed PDF download URL response */
export const OrderPdfUrlResponse = Type.Object({
  data: Type.Object({
    id: Type.String({ format: 'uuid' }),
    pdf_url: Type.String({ description: 'Pre-signed S3 GET URL for the generated PDF quotation' }),
    expires_in: Type.Integer({ description: 'URL expiry in seconds' }),
  }),
})

// --- Static Types ---

export type CreateOrderItemInput = Static<typeof CreateOrderItemBody>
export type CreateOrderInput = Static<typeof CreateOrderBody>
export type ListOrdersParams = Static<typeof ListOrdersQuery>

export type OrderItemResponseType = Static<typeof OrderItemResponse>
export type OrderResponseType = Static<typeof OrderResponse>
export type OrderDetailResponseType = Static<typeof OrderDetailResponse>
export type OrderListResponseType = Static<typeof OrderListResponse>
export type OrderMutationResponseType = Static<typeof OrderMutationResponse>
export type OrderDetailMutationResponseType = Static<typeof OrderDetailMutationResponse>
export type OrderPdfUrlResponseType = Static<typeof OrderPdfUrlResponse>
