import { Type, type Static } from '@sinclair/typebox'

// =============================================================================
// ERP Integration — Inbound Webhook Payload Schemas
//
// Each inbound sync endpoint receives a batch envelope containing:
//   - idempotency_key: UUID for Redis-backed duplicate detection (at-most-once)
//   - records: array of typed delta records to upsert
//
// Records are matched/upserted against their ERP business keys
// (erp_customer_code, erp_material_code, promo_code, batch, etc.) scoped to the
// tenant resolved from the authenticated Super Admin context.
// =============================================================================

// --- Shared Enum Schemas ---

/** Customer type — mirrors PostgreSQL customer_type_enum */
export const CustomerTypeSchema = Type.Union(
  [
    Type.Literal('OUTLET'),
    Type.Literal('DOCTOR'),
    Type.Literal('COMMUNITY'),
    Type.Literal('EVENT'),
  ],
  { description: 'Customer type: OUTLET, DOCTOR, COMMUNITY, or EVENT' },
)

/** Promotion type — mirrors PostgreSQL promo_type_enum */
export const PromoTypeSchema = Type.Union(
  [
    Type.Literal('PERCENT_DISCOUNT'),
    Type.Literal('FIXED_AMOUNT'),
    Type.Literal('FREE_GOODS'),
    Type.Literal('BUNDLING'),
  ],
  { description: 'Promotion type: PERCENT_DISCOUNT, FIXED_AMOUNT, FREE_GOODS, or BUNDLING' },
)

/** Field-force role targeted by an inbound lead — mirrors user_label_enum subset */
export const FieldRoleSchema = Type.Union([Type.Literal('SALESMAN'), Type.Literal('MR')], {
  description: 'Field role the lead is assigned to: SALESMAN or MR',
})

// --- Shared Fragments ---

/** Optional nullable string helper for delta fields that ERP may omit */
const NullableString = (description?: string) =>
  Type.Optional(Type.Union([Type.String(), Type.Null()], description ? { description } : {}))

/** Batch envelope wrapper — every inbound webhook shares this shape */
const BatchEnvelope = <T extends ReturnType<typeof Type.Object>>(
  recordSchema: T,
  recordDescription: string,
) =>
  Type.Object({
    idempotency_key: Type.String({
      format: 'uuid',
      description: 'Unique key for Redis duplicate detection (at-most-once delivery)',
    }),
    synced_at: Type.Optional(
      Type.String({ format: 'date-time', description: 'ERP-side timestamp when the batch was emitted' }),
    ),
    records: Type.Array(recordSchema, {
      minItems: 1,
      maxItems: 1000,
      description: recordDescription,
    }),
  })

// =============================================================================
// 1. Customer / Doctor Delta Sync
//    POST /erp/webhook/customers — upsert matching erp_customer_code
// =============================================================================

/** Doctor-specific attributes embedded when customer_type = DOCTOR */
const DoctorProfileDeltaSchema = Type.Object({
  sip_str_number: NullableString('SIP/STR license number'),
  specialization: NullableString('Primary medical specialization'),
  sub_specialization: NullableString('Sub-specialization'),
  notes: NullableString(),
})

export const CustomerDeltaSchema = Type.Object({
  erp_customer_code: Type.String({ minLength: 1, maxLength: 100, description: 'ERP business key for upsert matching' }),
  soffice_code: Type.String({ minLength: 1, description: 'ERP sales office code to resolve soffice_id' }),
  customer_type: CustomerTypeSchema,
  name: Type.String({ minLength: 1, maxLength: 255 }),
  customer_group: NullableString('Customer grouping/classification'),
  address: NullableString(),
  city: NullableString(),
  latitude: Type.Optional(Type.Union([Type.Number({ minimum: -90, maximum: 90 }), Type.Null()])),
  longitude: Type.Optional(Type.Union([Type.Number({ minimum: -180, maximum: 180 }), Type.Null()])),
  credit_limit: Type.Optional(Type.Number({ minimum: 0, description: 'Credit limit in tenant currency' })),
  credit_term_days: Type.Optional(Type.Integer({ minimum: 0 })),
  is_active: Type.Optional(Type.Boolean({ default: true })),
  doctor_profile: Type.Optional(DoctorProfileDeltaSchema),
})

export const CustomerSyncBody = BatchEnvelope(
  CustomerDeltaSchema,
  'Array of customer/doctor delta records keyed by erp_customer_code',
)

// =============================================================================
// 2. Material / SKU Sync
//    POST /erp/webhook/materials — upsert matching erp_material_code (with lini)
// =============================================================================

export const MaterialDeltaSchema = Type.Object({
  erp_material_code: Type.String({ minLength: 1, maxLength: 100, description: 'ERP business key for upsert matching' }),
  name: Type.String({ minLength: 1, maxLength: 255 }),
  base_uom: Type.String({ minLength: 1, maxLength: 20 }),
  sales_uom: Type.String({ minLength: 1, maxLength: 20 }),
  nie: NullableString('BPOM registration number (NIE)'),
  valid_nie: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  lini_code: NullableString('ERP business-line code to resolve lini_id'),
  manufacture: NullableString(),
  principal: NullableString(),
  uom_conversion_rules: Type.Unknown({ description: 'Hierarchical UOM conversion rules (JSONB): Karton → Box → Strip → Pcs' }),
  is_narcotic_psychotropic: Type.Optional(Type.Boolean({ default: false })),
  is_active: Type.Optional(Type.Boolean({ default: true })),
})

export const MaterialSyncBody = BatchEnvelope(
  MaterialDeltaSchema,
  'Array of material/SKU delta records keyed by erp_material_code',
)

// =============================================================================
// 3. Price List Sync
//    POST /erp/webhook/prices — upsert master_price (with varian & per)
// =============================================================================

export const PriceDeltaSchema = Type.Object({
  soffice_code: Type.String({ minLength: 1, description: 'ERP sales office code to resolve soffice_id' }),
  erp_material_code: Type.String({ minLength: 1, description: 'Material business key to resolve material_id' }),
  varian_code: NullableString('Variant code to resolve varian_id (null = default variant)'),
  price_regular: Type.Number({ minimum: 0, description: 'Regular selling price' }),
  price_hja: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  price_het: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  per: Type.Optional(Type.Integer({ minimum: 1, default: 1, description: 'Price is per N sales_uom units' })),
  sales_uom: Type.String({ minLength: 1, maxLength: 20 }),
  valid_from: Type.String({ format: 'date', description: 'Price validity start (YYYY-MM-DD)' }),
  valid_to: Type.String({ format: 'date', description: 'Price validity end (YYYY-MM-DD)' }),
})

export const PriceSyncBody = BatchEnvelope(
  PriceDeltaSchema,
  'Array of regional price delta records for master_price upsert',
)

// =============================================================================
// 4. Stock ATP Sync
//    POST /erp/webhook/stock — upsert stock_inventory_atp (with batch & SLED)
// =============================================================================

export const StockDeltaSchema = Type.Object({
  soffice_code: Type.String({ minLength: 1, description: 'ERP sales office code to resolve soffice_id' }),
  erp_material_code: Type.String({ minLength: 1, description: 'Material business key to resolve material_id' }),
  varian_code: NullableString('Variant code to resolve varian_id (null = default variant)'),
  batch: Type.String({ minLength: 1, maxLength: 100, description: 'Batch/lot number (part of unique key)' }),
  sled: Type.Optional(
    Type.Union([Type.String({ format: 'date' }), Type.Null()], {
      description: 'Shelf Life Expiration Date (YYYY-MM-DD)',
    }),
  ),
  qty_available: Type.Number({ minimum: 0, description: 'Available-to-Promise unrestricted quantity' }),
  qty_allocated: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
  stock_value: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  uom: Type.String({ minLength: 1, maxLength: 20 }),
})

export const StockSyncBody = BatchEnvelope(
  StockDeltaSchema,
  'Array of ATP stock delta records with batch & SLED for stock_inventory_atp upsert',
)

// =============================================================================
// 5. Promotion Sync
//    POST /erp/webhook/promotions — upsert master_promotions (with UOM refs)
// =============================================================================

export const PromotionDeltaSchema = Type.Object({
  promo_code: Type.String({ minLength: 1, maxLength: 100, description: 'ERP business key for upsert matching' }),
  promo_name: Type.String({ minLength: 1, maxLength: 255 }),
  promo_type: PromoTypeSchema,
  discount_percentage: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()])),
  discount_amount: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  min_order_qty: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  free_material_code: NullableString('Material code for FREE_GOODS/BUNDLING promos (resolves free_material_id)'),
  free_material_qty: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  valid_start: Type.String({ format: 'date-time', description: 'Promotion validity start' }),
  valid_end: Type.String({ format: 'date-time', description: 'Promotion validity end' }),
  is_active: Type.Optional(Type.Boolean({ default: true })),
})

export const PromotionSyncBody = BatchEnvelope(
  PromotionDeltaSchema,
  'Array of promotion delta records keyed by promo_code',
)

// =============================================================================
// 6. Leads Sync
//    POST /erp/webhook/leads — auto-create visit_plans for salesmen or MRs
// =============================================================================

export const LeadDeltaSchema = Type.Object({
  assignee_user_code: Type.String({ minLength: 1, description: 'ERP/user business key to resolve target user_id' }),
  assignee_role: Type.Optional(FieldRoleSchema),
  erp_customer_code: Type.String({ minLength: 1, description: 'Target customer business key to resolve customer_id' }),
  outlet_context_code: NullableString('Outlet context code for doctor visits (resolves outlet_context_id)'),
  plan_date: Type.String({ format: 'date', description: 'Planned visit date (YYYY-MM-DD)' }),
})

export const LeadSyncBody = BatchEnvelope(
  LeadDeltaSchema,
  'Array of lead records that auto-create visit_plans (is_lead_from_erp = true)',
)

// =============================================================================
// Shared Response Schemas
// =============================================================================

/** Per-record failure detail returned when a delta cannot be applied */
const SyncErrorSchema = Type.Object({
  index: Type.Integer({ description: 'Zero-based index of the failed record in the input array' }),
  business_key: Type.Optional(Type.String({ description: 'The ERP business key of the failed record, if known' })),
  code: Type.String({ description: 'Structured error code (e.g., SOFFICE_NOT_FOUND, MATERIAL_NOT_FOUND)' }),
  message: Type.String({ description: 'Human-readable error description' }),
})

/**
 * Uniform inbound sync result envelope returned by every webhook endpoint.
 * `duplicate` is true when the idempotency_key was already processed.
 */
export const ErpSyncResultResponse = Type.Object({
  data: Type.Object({
    idempotency_key: Type.String({ format: 'uuid' }),
    duplicate: Type.Boolean({ description: 'True if this idempotency_key was already processed' }),
    received: Type.Integer({ description: 'Total records in the batch' }),
    created: Type.Integer({ description: 'Records inserted' }),
    updated: Type.Integer({ description: 'Records updated' }),
    failed: Type.Integer({ description: 'Records that could not be applied' }),
    errors: Type.Array(SyncErrorSchema),
  }),
})

// --- Static Types ---

export type CustomerDelta = Static<typeof CustomerDeltaSchema>
export type CustomerSyncInput = Static<typeof CustomerSyncBody>
export type MaterialDelta = Static<typeof MaterialDeltaSchema>
export type MaterialSyncInput = Static<typeof MaterialSyncBody>
export type PriceDelta = Static<typeof PriceDeltaSchema>
export type PriceSyncInput = Static<typeof PriceSyncBody>
export type StockDelta = Static<typeof StockDeltaSchema>
export type StockSyncInput = Static<typeof StockSyncBody>
export type PromotionDelta = Static<typeof PromotionDeltaSchema>
export type PromotionSyncInput = Static<typeof PromotionSyncBody>
export type LeadDelta = Static<typeof LeadDeltaSchema>
export type LeadSyncInput = Static<typeof LeadSyncBody>
export type ErpSyncResult = Static<typeof ErpSyncResultResponse>
