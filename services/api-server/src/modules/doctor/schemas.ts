import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const UUIDParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
})

const PaginationMeta = Type.Object({
  page: Type.Integer(),
  limit: Type.Integer(),
  total: Type.Integer(),
})

// --- Path Parameter Schemas ---

/** Path params for /doctors/:id — doctor customer UUID */
export const DoctorIdParams = UUIDParamsSchema

/** Path params for /doctors/:id/assignments/:assignmentId */
export const AssignmentIdParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  assignmentId: Type.String({ format: 'uuid' }),
})

// --- Query Schemas ---

/** GET /doctors — paginated list with filters */
export const ListDoctorsQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  search: Type.Optional(Type.String({ description: 'Search by doctor name or SIP/STR number' })),
  specialization: Type.Optional(Type.String({ description: 'Filter by specialization' })),
  is_active: Type.Optional(Type.Boolean({ description: 'Filter by active status' })),
  soffice_id: Type.Optional(Type.String({ format: 'uuid', description: 'Filter by sales office' })),
})

// --- Response Schemas ---

/** Doctor profile response (specialization details from doctor_profiles) */
export const DoctorProfileResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  customer_id: Type.String({ format: 'uuid' }),
  sip_str_number: Type.Union([Type.String(), Type.Null()]),
  specialization: Type.Union([Type.String(), Type.Null()]),
  sub_specialization: Type.Union([Type.String(), Type.Null()]),
  practice_schedule: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
})

/** Outlet summary embedded in assignment response */
const OutletSummary = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  latitude: Type.Union([Type.Number(), Type.Null()]),
  longitude: Type.Union([Type.Number(), Type.Null()]),
})

/** Single doctor-outlet assignment response */
export const DoctorOutletAssignmentResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  doctor_customer_id: Type.String({ format: 'uuid' }),
  outlet_customer_id: Type.String({ format: 'uuid' }),
  room_or_department: Type.Union([Type.String(), Type.Null()]),
  is_primary_practice: Type.Boolean(),
  practice_days: Type.Union([Type.String(), Type.Null()]),
  practice_hours_start: Type.Union([Type.String(), Type.Null()]),
  practice_hours_end: Type.Union([Type.String(), Type.Null()]),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  outlet: Type.Optional(OutletSummary),
})

/** Doctor list item — customer fields + doctor profile */
export const DoctorListItemResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  erp_customer_code: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  latitude: Type.Union([Type.Number(), Type.Null()]),
  longitude: Type.Union([Type.Number(), Type.Null()]),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  doctor_profile: Type.Union([DoctorProfileResponse, Type.Null()]),
})

/** Doctor detail response — full profile + outlet assignments */
export const DoctorDetailResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  soffice_id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  erp_customer_code: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  latitude: Type.Union([Type.Number(), Type.Null()]),
  longitude: Type.Union([Type.Number(), Type.Null()]),
  is_active: Type.Boolean(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  doctor_profile: Type.Union([DoctorProfileResponse, Type.Null()]),
  assignments: Type.Array(DoctorOutletAssignmentResponse),
})

/** Paginated doctor list response */
export const DoctorListResponse = Type.Object({
  data: Type.Array(DoctorListItemResponse),
  meta: PaginationMeta,
})

/** Assignment list response */
export const AssignmentListResponse = Type.Object({
  data: Type.Array(DoctorOutletAssignmentResponse),
})

/** Assignment mutation response (create/update/delete) */
export const AssignmentMutationResponse = Type.Object({
  data: DoctorOutletAssignmentResponse,
})

// --- Request Body Schemas ---

/** PATCH /doctors/:id/profile — update/upsert doctor profile */
export const UpdateDoctorProfileBody = Type.Object({
  sip_str_number: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  specialization: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  sub_specialization: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  practice_schedule: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/** POST /doctors/:id/assignments — create a new outlet assignment */
export const CreateAssignmentBody = Type.Object({
  outlet_customer_id: Type.String({ format: 'uuid' }),
  room_or_department: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  is_primary_practice: Type.Optional(Type.Boolean({ default: false })),
  practice_days: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  practice_hours_start: Type.Optional(Type.Union([Type.String({ description: 'HH:MM format' }), Type.Null()])),
  practice_hours_end: Type.Optional(Type.Union([Type.String({ description: 'HH:MM format' }), Type.Null()])),
  is_active: Type.Optional(Type.Boolean({ default: true })),
})

/** PATCH /doctors/:id/assignments/:assignmentId — partial update */
export const UpdateAssignmentBody = Type.Object({
  room_or_department: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
  is_primary_practice: Type.Optional(Type.Boolean()),
  practice_days: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  practice_hours_start: Type.Optional(Type.Union([Type.String({ description: 'HH:MM format' }), Type.Null()])),
  practice_hours_end: Type.Optional(Type.Union([Type.String({ description: 'HH:MM format' }), Type.Null()])),
  is_active: Type.Optional(Type.Boolean()),
})

// --- Static Types ---

export type ListDoctorsParams = Static<typeof ListDoctorsQuery>
export type DoctorProfileResponseType = Static<typeof DoctorProfileResponse>
export type DoctorOutletAssignmentResponseType = Static<typeof DoctorOutletAssignmentResponse>
export type DoctorListItemResponseType = Static<typeof DoctorListItemResponse>
export type DoctorDetailResponseType = Static<typeof DoctorDetailResponse>
export type UpdateDoctorProfileInput = Static<typeof UpdateDoctorProfileBody>
export type CreateAssignmentInput = Static<typeof CreateAssignmentBody>
export type UpdateAssignmentInput = Static<typeof UpdateAssignmentBody>
