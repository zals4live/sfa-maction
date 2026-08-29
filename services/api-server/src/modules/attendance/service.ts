import { eq, and, sql, count, gte, lte } from 'drizzle-orm'

import { withRLS, calculateDistanceToSoffice, type RLSContext } from '../../db'
import { generateUploadUrl, buildS3Key, type AllowedMimeType } from '../../config/s3'
import { absensi } from '../../db/schema/auth'
import { companies } from '../../db/schema/tenant'
import type {
  CheckInInput,
  CheckOutInput,
  AttendanceHistoryParams,
  AttendanceRecordType,
  UploadUrlInput,
} from './schemas'

/** Structured error thrown by service functions for route-level handling. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400
  ) {
    super(message)
  }
}

/** Context required for attendance operations (derived from JWT claims). */
interface AttendanceContext {
  companyId: string
  userId: string
  sofficeId: string
  userRole: string
}

/** Formats today's date as YYYY-MM-DD. */
function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0]!
}

/** Maps a Drizzle row to the snake_case API response shape. */
function mapToResponse(row: typeof absensi.$inferSelect): AttendanceRecordType {
  const checkInGeom = row.checkInGeom as unknown as { x: number; y: number } | null
  const checkOutGeom = row.checkOutGeom as unknown as { x: number; y: number } | null

  return {
    id: row.id,
    company_id: row.companyId,
    user_id: row.userId,
    attendance_date: row.attendanceDate,
    attendance_type: row.attendanceType as 'OFFICE' | 'CUSTOMER' | 'OTHER',
    check_in_time: row.checkInTime,
    check_in_latitude: checkInGeom?.y ?? 0,
    check_in_longitude: checkInGeom?.x ?? 0,
    check_in_photo_s3_key: row.checkInPhotoS3Key,
    check_in_distance_meters: row.checkInDistanceMeters ?? null,
    check_out_time: row.checkOutTime ?? null,
    check_out_latitude: checkOutGeom?.y ?? null,
    check_out_longitude: checkOutGeom?.x ?? null,
    check_out_photo_s3_key: row.checkOutPhotoS3Key ?? null,
    notes: row.notes ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

/** Check-in with geofence validation against the user's assigned soffice. */
export async function checkIn(
  input: CheckInInput,
  ctx: AttendanceContext
): Promise<AttendanceRecordType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const today = getTodayDateString()

    // Check for duplicate check-in today
    const existing = await tx
      .select({ id: absensi.id })
      .from(absensi)
      .where(
        and(
          eq(absensi.companyId, ctx.companyId),
          eq(absensi.userId, ctx.userId),
          eq(absensi.attendanceDate, today)
        )
      )
      .limit(1)

    if (existing.length > 0) {
      throw new ServiceError(
        'ALREADY_CHECKED_IN',
        'You have already checked in today',
        409
      )
    }

    // Compute geofence distance via PostGIS utility
    const { distance_meters: distanceMetersRaw, geofence_radius_meters: geofenceRadius } =
      await calculateDistanceToSoffice(
        tx,
        { latitude: input.latitude, longitude: input.longitude },
        ctx.sofficeId,
        ctx.companyId
      )

    const distanceMeters = distanceMetersRaw

    // Soft reject: record but flag when outside geofence (for OFFICE type)
    const isOutOfRange =
      input.attendance_type === 'OFFICE' &&
      distanceMeters !== null &&
      distanceMeters > geofenceRadius

    // Insert attendance record
    const [row] = await tx
      .insert(absensi)
      .values({
        companyId: ctx.companyId,
        userId: ctx.userId,
        attendanceDate: today,
        attendanceType: input.attendance_type,
        checkInTime: new Date().toISOString(),
        checkInGeom: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)`,
        checkInPhotoS3Key: input.photo_s3_key,
        checkInDistanceMeters: distanceMeters,
        notes: input.notes ?? null,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')

    const response = mapToResponse(row)

    // If soft-rejected, we still return data but the caller can inspect distance
    if (isOutOfRange) {
      // Record is saved with distance for admin review
      // Route layer can inspect check_in_distance_meters > geofence_radius
    }

    return response
  })
}

/** Check-out with time rule enforcement (only after 16:00). */
export async function checkOut(
  input: CheckOutInput,
  ctx: AttendanceContext
): Promise<AttendanceRecordType> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const today = getTodayDateString()

    // Find today's check-in
    const [record] = await tx
      .select()
      .from(absensi)
      .where(
        and(
          eq(absensi.companyId, ctx.companyId),
          eq(absensi.userId, ctx.userId),
          eq(absensi.attendanceDate, today)
        )
      )
      .limit(1)

    if (!record) {
      throw new ServiceError(
        'NO_CHECKIN_TODAY',
        'No check-in record found for today. Please check in first.',
        404
      )
    }

    if (record.checkOutTime) {
      throw new ServiceError(
        'ALREADY_CHECKED_OUT',
        'You have already checked out today',
        409
      )
    }

    // Retrieve tenant's configurable checkout minimum hour (default 16)
    const [company] = await tx
      .select({ checkoutMinHour: companies.checkoutMinHour })
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .limit(1)

    const minHour = company?.checkoutMinHour ?? 16

    // Enforce checkout time rule: only after configured minimum hour
    const now = new Date()
    const currentHour = now.getHours()
    if (currentHour < minHour) {
      throw new ServiceError(
        'CHECKOUT_TOO_EARLY',
        `Check-out is only allowed after ${String(minHour).padStart(2, '0')}:00. Current time is too early.`,
        403
      )
    }

    // Update with check-out data
    const [updated] = await tx
      .update(absensi)
      .set({
        checkOutTime: now.toISOString(),
        checkOutGeom: sql`ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)`,
        checkOutPhotoS3Key: input.photo_s3_key ?? null,
        notes: input.notes ?? record.notes,
      })
      .where(eq(absensi.id, record.id))
      .returning()

    if (!updated) throw new Error('Update returned no rows')

    return mapToResponse(updated)
  })
}

/** Returns today's attendance record for the authenticated user (or null). */
export async function getTodayAttendance(
  ctx: AttendanceContext
): Promise<AttendanceRecordType | null> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  return withRLS(rlsCtx, async (tx) => {
    const today = getTodayDateString()

    const [record] = await tx
      .select()
      .from(absensi)
      .where(
        and(
          eq(absensi.companyId, ctx.companyId),
          eq(absensi.userId, ctx.userId),
          eq(absensi.attendanceDate, today)
        )
      )
      .limit(1)

    return record ? mapToResponse(record) : null
  })
}

/** Paginated attendance history with optional date range filtering. */
export async function getAttendanceHistory(
  params: AttendanceHistoryParams,
  ctx: AttendanceContext
): Promise<{ data: AttendanceRecordType[]; meta: { page: number; limit: number; total: number } }> {
  const rlsCtx: RLSContext = {
    companyId: ctx.companyId,
    userId: ctx.userId,
    userRole: ctx.userRole,
  }

  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  return withRLS(rlsCtx, async (tx) => {
    const conditions = [
      eq(absensi.companyId, ctx.companyId),
      eq(absensi.userId, ctx.userId),
    ]

    if (params.start_date) {
      conditions.push(gte(absensi.attendanceDate, params.start_date))
    }
    if (params.end_date) {
      conditions.push(lte(absensi.attendanceDate, params.end_date))
    }

    const whereClause = and(...conditions)

    const [rows, totalResult] = await Promise.all([
      tx
        .select()
        .from(absensi)
        .where(whereClause)
        .orderBy(sql`${absensi.attendanceDate} DESC`)
        .limit(limit)
        .offset(offset),
      tx
        .select({ total: count() })
        .from(absensi)
        .where(whereClause),
    ])

    return {
      data: rows.map(mapToResponse),
      meta: { page, limit, total: totalResult[0]?.total ?? 0 },
    }
  })
}

/** MIME type to file extension mapping for selfie uploads. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const UPLOAD_URL_EXPIRY_SECONDS = 900

/** Generates a pre-signed S3 PUT URL for selfie upload. */
export async function generateSelfieUploadUrl(
  input: UploadUrlInput,
  ctx: Pick<AttendanceContext, 'companyId'>
): Promise<{ upload_url: string; s3_key: string; expires_in: number }> {
  const fileId = crypto.randomUUID()
  const extension = MIME_TO_EXT[input.content_type] ?? 'jpg'

  const s3Key = buildS3Key({
    companyId: ctx.companyId,
    category: 'attendance',
    fileId,
    extension,
  })

  const uploadUrl = await generateUploadUrl({
    key: s3Key,
    contentType: input.content_type as AllowedMimeType,
    expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
  })

  return { upload_url: uploadUrl, s3_key: s3Key, expires_in: UPLOAD_URL_EXPIRY_SECONDS }
}
