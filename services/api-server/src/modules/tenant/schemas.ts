import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const erpSystemTypes = ['SAP_S4HANA', 'SAP_ECC', 'QAD', 'CUSTOM_REST'] as const

const ERPSystemTypeSchema = Type.Union(
  erpSystemTypes.map((v) => Type.Literal(v)),
  { description: 'ERP system integration type' }
)

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

// --- Request Schemas ---

/** POST /tenants — create a new tenant company */
export const CreateCompanyBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 50 }),
  name: Type.String({ minLength: 1, maxLength: 255 }),
  logo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  erp_system_type: Type.Optional(ERPSystemTypeSchema),
  erp_endpoint_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  erp_company_code: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  default_tax_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  geofence_radius_meters: Type.Optional(Type.Integer({ minimum: 1 })),
  checkout_min_hour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23, description: 'Minimum hour (0-23) before checkout is allowed. Defaults to 16.' })),
})

/** PATCH /tenants/:id — partial update */
export const UpdateCompanyBody = Type.Object({
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  logo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  default_tax_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  geofence_radius_meters: Type.Optional(Type.Integer({ minimum: 1 })),
  checkout_min_hour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23, description: 'Minimum hour (0-23) before checkout is allowed. Defaults to 16.' })),
})

/** PUT /tenants/:id/erp-config — ERP gateway configuration */
export const UpdateERPConfigBody = Type.Object({
  erp_system_type: ERPSystemTypeSchema,
  erp_endpoint_url: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  erp_auth_config: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  erp_company_code: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
})

/** GET /tenants — pagination and search query params */
export const ListCompaniesQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(Type.String()),
})

/** Path params with UUID id */
export const CompanyIdParams = UUIDParamsSchema

// --- Response Schemas ---

/** Single company response object */
export const CompanyResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  code: Type.String(),
  name: Type.String(),
  is_active: Type.Boolean(),
  logo_s3_key: Type.Union([Type.String(), Type.Null()]),
  default_tax_rate: Type.Number(),
  geofence_radius_meters: Type.Integer(),
  checkout_min_hour: Type.Integer(),
  erp_system_type: Type.Union([ERPSystemTypeSchema, Type.Null()]),
  erp_endpoint_url: Type.Union([Type.String(), Type.Null()]),
  erp_auth_config: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  erp_company_code: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  updated_at: Type.String(),
})

/** Paginated company list response */
export const CompanyListResponse = Type.Object({
  data: Type.Array(CompanyResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

// --- Static Types ---

export type CreateCompanyInput = Static<typeof CreateCompanyBody>
export type UpdateCompanyInput = Static<typeof UpdateCompanyBody>
export type UpdateERPConfigInput = Static<typeof UpdateERPConfigBody>
export type ListCompaniesParams = Static<typeof ListCompaniesQuery>
export type CompanyResponseType = Static<typeof CompanyResponse>
