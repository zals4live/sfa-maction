import { Type, type Static } from '@sinclair/typebox'

// --- Shared Schema Fragments ---

const attendanceTypes = ['OFFICE', 'CUSTOMER', 'OTHER'] as const

export const AttendanceTypeSchema = Type.Union(
  attendanceTypes.map((v) => Type.Literal(v)),
  { description: 'Attendance category matching attendance_type_enum' }
)

const GeomSchema = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracy: Type.Number({ minimum: 3, maximum: 50, description: 'GPS accuracy in meters (3m–50m valid range per anti-spoofing policy)' }),
})

const AntiSpoofFieldsSchema = {
  monotonic_delta_ms: Type.Number({ description: 'performance.now() hardware clock delta in milliseconds' }),
  client_timestamp: Type.String({ format: 'date-time', description: 'ISO 8601 client-side timestamp for clock drift detection' }),
}

// --- Request Schemas ---

/** POST /attendance/check-in — request body */
export const CheckInBody = Type.Object({
  attendance_type: AttendanceTypeSchema,
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracy: Type.Number({ minimum: 3, maximum: 50 }),
  photo_s3_key: Type.String({ minLength: 1, description: 'S3 key of the uploaded selfie photo' }),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ...AntiSpoofFieldsSchema,
})

/** POST /attendance/check-out — request body */
export const CheckOutBody = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracy: Type.Number({ minimum: 3, maximum: 50 }),
  photo_s3_key: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ...AntiSpoofFieldsSchema,
})

/** GET /attendance/history — query params */
export const AttendanceHistoryQuery = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  start_date: Type.Optional(Type.String({ format: 'date', description: 'Filter start date (YYYY-MM-DD)' })),
  end_date: Type.Optional(Type.String({ format: 'date', description: 'Filter end date (YYYY-MM-DD)' })),
})

// --- Response Schemas ---

/** Single attendance record */
export const AttendanceResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  company_id: Type.String({ format: 'uuid' }),
  user_id: Type.String({ format: 'uuid' }),
  attendance_date: Type.String({ format: 'date' }),
  attendance_type: AttendanceTypeSchema,
  check_in_time: Type.String({ format: 'date-time' }),
  check_in_latitude: Type.Number(),
  check_in_longitude: Type.Number(),
  check_in_photo_s3_key: Type.String(),
  check_in_distance_meters: Type.Union([Type.Integer(), Type.Null()]),
  check_out_time: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  check_out_latitude: Type.Union([Type.Number(), Type.Null()]),
  check_out_longitude: Type.Union([Type.Number(), Type.Null()]),
  check_out_photo_s3_key: Type.Union([Type.String(), Type.Null()]),
  notes: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
})

/** GET /attendance/today — response (nullable when no check-in exists) */
export const AttendanceTodayResponse = Type.Object({
  data: Type.Union([AttendanceResponse, Type.Null()]),
})

/** GET /attendance/history — paginated list response */
export const AttendanceListResponse = Type.Object({
  data: Type.Array(AttendanceResponse),
  meta: Type.Object({
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
  }),
})

/** POST /attendance/check-in & check-out — success response */
export const AttendanceMutationResponse = Type.Object({
  data: AttendanceResponse,
})

// --- Upload URL Schemas ---

const selfieImageMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const

export const UploadUrlBody = Type.Object({
  content_type: Type.Union(
    selfieImageMimeTypes.map((v) => Type.Literal(v)),
    { description: 'MIME type for selfie image upload (jpeg, png, or webp only)' }
  ),
  purpose: Type.Optional(
    Type.Union([Type.Literal('check_in'), Type.Literal('check_out')], {
      description: 'Upload purpose context',
    })
  ),
})

export const UploadUrlResponse = Type.Object({
  data: Type.Object({
    upload_url: Type.String({ description: 'Pre-signed S3 PUT URL' }),
    s3_key: Type.String({ description: 'S3 object key to reference after upload' }),
    expires_in: Type.Integer({ description: 'URL expiry in seconds' }),
  }),
})

// --- Static Types ---

export type CheckInInput = Static<typeof CheckInBody>
export type CheckOutInput = Static<typeof CheckOutBody>
export type AttendanceHistoryParams = Static<typeof AttendanceHistoryQuery>
export type AttendanceRecordType = Static<typeof AttendanceResponse>
export type AttendanceTodayResponseType = Static<typeof AttendanceTodayResponse>
export type AttendanceListResponseType = Static<typeof AttendanceListResponse>
export type AttendanceMutationResponseType = Static<typeof AttendanceMutationResponse>
export type UploadUrlInput = Static<typeof UploadUrlBody>
export type UploadUrlResponseType = Static<typeof UploadUrlResponse>
