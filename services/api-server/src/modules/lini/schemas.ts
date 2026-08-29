import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

const PaginationQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(Type.String({ description: 'Search by code or name' })),
  is_active: Type.Optional(Type.Boolean({ description: 'Filter by active status' })),
})

// --- Lini Request Schemas ---

/** POST /lini — create a new business line */
export const CreateLiniBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 50 }),
  name: Type.String({ minLength: 1, maxLength: 150 }),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  is_active: Type.Optional(Type.Boolean({ default: true })),
})

/** PATCH /lini/:id — partial update */
export const UpdateLiniBody = Type.Object({
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  is_active: Type.Optional(Type.Boolean()),
})

/** GET /lini — pagination and filter query params */
export const ListLiniQuery = PaginationQuery

/** Path params with UUID id */
export const LiniIdParams = UUIDParamsSchema

// --- Lini Response Schemas ---

/** Single lini response object */
export const LiniResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  code: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** Paginated lini list response */
export const LiniListResponse = Type.Object({
  data: Type.Array(LiniResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Single lini mutation response */
export const LiniMutationResponse = Type.Object({
  data: LiniResponse,
})

// --- Varian Request Schemas ---

/** POST /varian — create a new product variant */
export const CreateVarianBody = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 50 }),
  name: Type.String({ minLength: 1, maxLength: 150 }),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  is_active: Type.Optional(Type.Boolean({ default: true })),
})

/** PATCH /varian/:id — partial update */
export const UpdateVarianBody = Type.Object({
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  is_active: Type.Optional(Type.Boolean()),
})

/** GET /varian — pagination and filter query params */
export const ListVarianQuery = PaginationQuery

/** Path params with UUID id */
export const VarianIdParams = UUIDParamsSchema

// --- Varian Response Schemas ---

/** Single varian response object */
export const VarianResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  code: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** Paginated varian list response */
export const VarianListResponse = Type.Object({
  data: Type.Array(VarianResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** Single varian mutation response */
export const VarianMutationResponse = Type.Object({
  data: VarianResponse,
})

// --- User-Lini Assignment Request Schemas ---

/** Path params for user-lini endpoints */
export const UserIdParams = Type.Object({
  userId: Type.String({ format: 'uuid' }),
})

/** Path params for deleting a specific user-lini assignment */
export const UserLiniDeleteParams = Type.Object({
  userId: Type.String({ format: 'uuid' }),
  liniId: Type.String({ format: 'uuid' }),
})

/** GET /users/:userId/lini query params */
export const ListUserLiniQuery = Type.Object({
  is_active: Type.Optional(Type.Boolean({ description: 'Filter by active status' })),
})

/** POST /users/:userId/lini body */
export const AssignUserLiniBody = Type.Object({
  lini_ids: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 50 }),
})

// --- User-Lini Assignment Response Schemas ---

/** Single user-lini assignment response */
export const UserLiniAssignmentResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  user_id: Type.String({ format: 'uuid' }),
  lini_id: Type.String({ format: 'uuid' }),
  lini_code: Type.String(),
  lini_name: Type.String(),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
})

// --- Static Types ---

export type CreateLiniInput = Static<typeof CreateLiniBody>
export type UpdateLiniInput = Static<typeof UpdateLiniBody>
export type ListLiniParams = Static<typeof ListLiniQuery>
export type LiniResponseType = Static<typeof LiniResponse>

export type CreateVarianInput = Static<typeof CreateVarianBody>
export type UpdateVarianInput = Static<typeof UpdateVarianBody>
export type ListVarianParams = Static<typeof ListVarianQuery>
export type VarianResponseType = Static<typeof VarianResponse>

export type ListUserLiniParams = Static<typeof ListUserLiniQuery>
export type AssignUserLiniInput = Static<typeof AssignUserLiniBody>
export type UserLiniAssignmentResponseType = Static<typeof UserLiniAssignmentResponse>
