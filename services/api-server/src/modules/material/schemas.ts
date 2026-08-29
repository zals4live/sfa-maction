import { Type, type Static } from '@sinclair/typebox'

// --- Enum Schemas ---

const promoTypes = ['PERCENT_DISCOUNT', 'FIXED_AMOUNT', 'FREE_GOODS', 'BUNDLING'] as const

/** Promotion type — mirrors PostgreSQL promo_type_enum */
export const PromoTypeSchema = Type.Union(
  promoTypes.map((v) => Type.Literal(v)),
  { description: 'Promotion type: PERCENT_DISCOUNT, FIXED_AMOUNT, FREE_GOODS, or BUNDLING' }
)

// --- Shared Schema Fragments ---

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

// --- Path Params ---

/** Path params with UUID id (used by :id, :id/price, :id/stock routes) */
export const MaterialIdParams = UUIDParamsSchema

// --- Request Schemas ---

/**
 * GET /materials — paginated material list.
 * `lini_id` is the optional business-line filter (lini scoping is also enforced
 * at the RLS layer for SALESMAN/MR field roles).
 */
export const ListMaterialsQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(
    Type.String({ description: 'Free-text search across material name and erp_material_code' })
  ),
  lini_id: Type.Optional(
    Type.String({ format: 'uuid', description: 'Filter by business line (lini)' })
  ),
  is_active: Type.Optional(Type.Boolean({ description: 'Filter by active status' })),
})

/** GET /materials/:id/price — current price lookup for a branch + variant */
export const MaterialPriceQuery = Type.Object({
  varian_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by product variant' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by sales office (branch)' })),
  as_of: Type.Optional(
    Type.String({ format: 'date', description: 'Resolve the price valid on this date (YYYY-MM-DD)' })
  ),
})

/** GET /materials/:id/stock — ATP stock lookup for a branch + variant */
export const MaterialStockQuery = Type.Object({
  varian_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by product variant' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by sales office (branch)' })),
})

/** GET /promotions — paginated active promotions list */
export const ListPromotionsQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  is_active: Type.Optional(Type.Boolean({ description: 'Filter by active status' })),
  as_of: Type.Optional(
    Type.String({ format: 'date', description: 'Only promotions valid on this date (YYYY-MM-DD)' })
  ),
})

// --- Response Schemas ---

/** Single material master record — mirrors masterMaterial columns */
export const MaterialResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  erp_material_code: Type.String(),
  name: Type.String(),
  base_uom: Type.String(),
  sales_uom: Type.String(),
  nie: Type.Union([Type.String(), Type.Null()]),
  valid_nie: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
  lini_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  manufacture: Type.Union([Type.String(), Type.Null()]),
  principal: Type.Union([Type.String(), Type.Null()]),
  uom_conversion_rules: Type.Unknown({ description: 'Hierarchical UOM conversion rules (JSONB)' }),
  is_narcotic_psychotropic: Type.Boolean(),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** Paginated material list response */
export const MaterialListResponse = Type.Object({
  data: Type.Array(MaterialResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Single price record — mirrors masterPrice columns */
export const MaterialPriceResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  material_id: Type.String({ format: 'uuid' }),
  varian_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  price_regular: Type.Number(),
  price_hja: Type.Union([Type.Number(), Type.Null()]),
  price_het: Type.Union([Type.Number(), Type.Null()]),
  per: Type.Integer(),
  sales_uom: Type.String(),
  valid_from: Type.String({ format: 'date' }),
  valid_to: Type.String({ format: 'date' }),
  created_at: Type.String({ format: 'date-time' }),
})

/** Single ATP stock record — mirrors stockInventoryAtp columns (batch & SLED) */
export const MaterialStockResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  material_id: Type.String({ format: 'uuid' }),
  varian_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  batch: Type.String(),
  sled: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
  qty_available: Type.Number(),
  qty_allocated: Type.Number(),
  stock_value: Type.Union([Type.Number(), Type.Null()]),
  uom: Type.String(),
  last_synced_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})

/** Single promotion record — mirrors masterPromotions columns */
export const PromotionResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  promo_code: Type.String(),
  promo_name: Type.String(),
  promo_type: PromoTypeSchema,
  discount_percentage: Type.Union([Type.Number(), Type.Null()]),
  discount_amount: Type.Union([Type.Number(), Type.Null()]),
  min_order_qty: Type.Union([Type.Integer(), Type.Null()]),
  free_material_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  free_material_qty: Type.Union([Type.Integer(), Type.Null()]),
  valid_start: Type.String({ format: 'date-time' }),
  valid_end: Type.String({ format: 'date-time' }),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
})

/** Paginated promotion list response */
export const PromotionListResponse = Type.Object({
  data: Type.Array(PromotionResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

// --- Static Types ---

export type ListMaterialsParams = Static<typeof ListMaterialsQuery>
export type MaterialIdParamsType = Static<typeof MaterialIdParams>
export type MaterialPriceParams = Static<typeof MaterialPriceQuery>
export type MaterialStockParams = Static<typeof MaterialStockQuery>
export type ListPromotionsParams = Static<typeof ListPromotionsQuery>

export type MaterialResponseType = Static<typeof MaterialResponse>
export type MaterialListResponseType = Static<typeof MaterialListResponse>
export type MaterialPriceResponseType = Static<typeof MaterialPriceResponse>
export type MaterialStockResponseType = Static<typeof MaterialStockResponse>
export type PromotionResponseType = Static<typeof PromotionResponse>
export type PromotionListResponseType = Static<typeof PromotionListResponse>
