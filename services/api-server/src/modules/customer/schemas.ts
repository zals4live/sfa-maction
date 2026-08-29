import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

const PaginationQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(Type.String({ description: 'Search by name, ERP code, or city' })),
})

// --- Customer Type Enum ---

const customerTypes = ['OUTLET', 'DOCTOR', 'COMMUNITY', 'EVENT'] as const

export const CustomerTypeSchema = Type.Union(
  customerTypes.map((v) => Type.Literal(v)),
  { description: 'Customer type discriminator' }
)

// --- Geom Schema Fragment ---

const GeomSchema = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
})

// --- Doctor Profile Fragment (for inline creation) ---

const DoctorProfileInput = Type.Object({
  sip_str_number: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  specialization: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  sub_specialization: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  practice_schedule: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

// --- Customer Request Schemas ---

/** POST /customers — create a new customer (Outlet or Doctor) */
export const CreateCustomerBody = Type.Object({
  customer_type: CustomerTypeSchema,
  soffice_id: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 255 }),
  erp_customer_code: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  customer_group: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  city: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  location: Type.Optional(Type.Union([GeomSchema, Type.Null()])),
  credit_limit: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  credit_term_days: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  is_active: Type.Optional(Type.Boolean({ default: true })),
  doctor_profile: Type.Optional(DoctorProfileInput),
})

/** PATCH /customers/:id — partial update */
export const UpdateCustomerBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  erp_customer_code: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  customer_group: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  city: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  location: Type.Optional(Type.Union([GeomSchema, Type.Null()])),
  credit_limit: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
  credit_term_days: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  is_active: Type.Optional(Type.Boolean()),
  doctor_profile: Type.Optional(DoctorProfileInput),
})

/** GET /customers — paginated list with filters */
export const ListCustomersQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(Type.String({ description: 'Search by name, ERP code, or city' })),
  customer_type: Type.Optional(CustomerTypeSchema),
  is_active: Type.Optional(Type.Boolean({ description: 'Filter by active status' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by sales office' })),
  city: Type.Optional(Type.String({ description: 'Filter by city' })),
})

/** Path params with UUID id */
export const CustomerIdParams = UUIDParamsSchema

// --- Customer Response Schemas ---

/** Single customer response object */
export const CustomerResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  customer_type: CustomerTypeSchema,
  erp_customer_code: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  customer_group: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  latitude: Type.Union([Type.Number(), Type.Null()]),
  longitude: Type.Union([Type.Number(), Type.Null()]),
  credit_limit: Type.Union([Type.Number(), Type.Null()]),
  credit_term_days: Type.Union([Type.Integer(), Type.Null()]),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** Doctor profile response (nested in detail view) */
export const DoctorProfileResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  sip_str_number: Type.Union([Type.String(), Type.Null()]),
  specialization: Type.Union([Type.String(), Type.Null()]),
  sub_specialization: Type.Union([Type.String(), Type.Null()]),
  practice_schedule: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** PIC response object */
export const PicResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  pic_name: Type.String(),
  position_title: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  is_primary: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
})

/** Customer detail response — includes PICs and optional doctor profile */
export const CustomerDetailResponse = Type.Object({
  ...CustomerResponse.properties,
  pics: Type.Array(PicResponse),
  doctor_profile: Type.Union([DoctorProfileResponse, Type.Null()]),
})

/** Paginated customer list response */
export const CustomerListResponse = Type.Object({
  data: Type.Array(CustomerResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Single customer mutation response */
export const CustomerMutationResponse = Type.Object({
  data: CustomerResponse,
})

/** Customer detail mutation response (with nested data) */
export const CustomerDetailMutationResponse = Type.Object({
  data: CustomerDetailResponse,
})

// --- PIC Request Schemas ---

/** POST /customers/:id/pics — create a new PIC */
export const CreatePicBody = Type.Object({
  pic_name: Type.String({ minLength: 1, maxLength: 150 }),
  position_title: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  is_primary: Type.Optional(Type.Boolean({ default: false })),
})

/** PATCH /customers/:id/pics/:picId — partial update */
export const UpdatePicBody = Type.Object({
  pic_name: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
  position_title: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  is_primary: Type.Optional(Type.Boolean()),
})

/** Path params for PIC sub-resource */
export const PicIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  picId: Type.String({ format: 'uuid' }),
})

/** PIC list response */
export const PicListResponse = Type.Object({
  data: Type.Array(PicResponse),
})

/** PIC mutation response */
export const PicMutationResponse = Type.Object({
  data: PicResponse,
})

// --- Bulk Import Schemas ---

/** POST /customers/bulk-import — multipart file upload response */
export const BulkImportResponse = Type.Object({
  imported: Type.Integer({ minimum: 0 }),
  errors: Type.Array(Type.Object({
    row: Type.Integer(),
    field: Type.Union([Type.String(), Type.Null()]),
    message: Type.String(),
  })),
})

// --- Static Types ---

export type CreateCustomerInput = Static<typeof CreateCustomerBody>
export type UpdateCustomerInput = Static<typeof UpdateCustomerBody>
export type ListCustomersParams = Static<typeof ListCustomersQuery>
export type CustomerResponseType = Static<typeof CustomerResponse>
export type CustomerDetailResponseType = Static<typeof CustomerDetailResponse>

export type CreatePicInput = Static<typeof CreatePicBody>
export type UpdatePicInput = Static<typeof UpdatePicBody>
export type PicResponseType = Static<typeof PicResponse>

export type BulkImportResponseType = Static<typeof BulkImportResponse>
