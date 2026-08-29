import { eq, and, ilike, or, count, sql, ne } from 'drizzle-orm'

import type { Transaction } from '../../db'
import {
  masterCustomer,
  doctorProfiles,
  doctorOutletAssignments,
} from '../../db/schema/customer'
import type {
  ListDoctorsParams,
  DoctorListItemResponseType,
  DoctorDetailResponseType,
  DoctorOutletAssignmentResponseType,
  UpdateDoctorProfileInput,
  CreateAssignmentInput,
  UpdateAssignmentInput,
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

// --- Types ---

type CustomerRow = typeof masterCustomer.$inferSelect
type DoctorProfileRow = typeof doctorProfiles.$inferSelect
type AssignmentRow = typeof doctorOutletAssignments.$inferSelect

// --- Mappers ---

function mapDoctorProfileToResponse(row: DoctorProfileRow) {
  return {
    id: row.id,
    customer_id: row.customerId,
    sip_str_number: row.sipStrNumber ?? null,
    specialization: row.specialization ?? null,
    sub_specialization: row.subSpecialization ?? null,
    practice_schedule: (row.practiceSchedule as Record<string, unknown>) ?? null,
    notes: row.notes ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

function mapDoctorListItem(
  row: CustomerRow,
  latitude: number | null,
  longitude: number | null,
  profile: DoctorProfileRow | null
): DoctorListItemResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    soffice_id: row.sofficeId,
    name: row.name,
    erp_customer_code: row.erpCustomerCode ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    latitude,
    longitude,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
    doctor_profile: profile ? mapDoctorProfileToResponse(profile) : null,
  }
}

function mapAssignmentToResponse(
  row: AssignmentRow,
  outlet?: { id: string; name: string; address: string | null; city: string | null; latitude: number | null; longitude: number | null } | null
): DoctorOutletAssignmentResponseType {
  return {
    id: row.id,
    doctor_customer_id: row.doctorCustomerId,
    outlet_customer_id: row.outletCustomerId,
    room_or_department: row.roomOrDepartment ?? null,
    is_primary_practice: row.isPrimaryPractice ?? false,
    practice_days: row.practiceDays ?? null,
    practice_hours_start: row.practiceHoursStart ?? null,
    practice_hours_end: row.practiceHoursEnd ?? null,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
    ...(outlet ? { outlet } : {}),
  }
}

// --- Doctor Listing ---

/** Lists doctors (masterCustomer with customerType='DOCTOR') with optional filtering and pagination. */
export async function listDoctors(
  tx: Transaction,
  params: ListDoctorsParams
): Promise<{ data: DoctorListItemResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const conditions = buildDoctorFilters(params)
  const whereClause = and(...conditions)

  const latCol = sql<number | null>`ST_Y(${masterCustomer.locationGeom})::float`.as('latitude')
  const lngCol = sql<number | null>`ST_X(${masterCustomer.locationGeom})::float`.as('longitude')

  const [rows, totalResult] = await Promise.all([
    tx
      .select({
        customer: masterCustomer,
        latitude: latCol,
        longitude: lngCol,
        profile: doctorProfiles,
      })
      .from(masterCustomer)
      .leftJoin(doctorProfiles, eq(doctorProfiles.customerId, masterCustomer.id))
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(masterCustomer.name),
    tx
      .select({ total: count() })
      .from(masterCustomer)
      .where(whereClause),
  ])

  return {
    data: rows.map((r) => mapDoctorListItem(r.customer, r.latitude, r.longitude, r.profile)),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

// --- Doctor Detail ---

/** Retrieves a single doctor with profile and all active outlet assignments. */
export async function getDoctorById(
  tx: Transaction,
  doctorCustomerId: string
): Promise<DoctorDetailResponseType> {
  const latCol = sql<number | null>`ST_Y(${masterCustomer.locationGeom})::float`.as('latitude')
  const lngCol = sql<number | null>`ST_X(${masterCustomer.locationGeom})::float`.as('longitude')

  const [row] = await tx
    .select({ customer: masterCustomer, latitude: latCol, longitude: lngCol })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.id, doctorCustomerId),
        eq(masterCustomer.customerType, 'DOCTOR'),
        eq(masterCustomer.isDeleted, false)
      )
    )

  if (!row) {
    throw new ServiceError('DOCTOR_NOT_FOUND', `Doctor '${doctorCustomerId}' not found`, 404)
  }

  const [profile, assignments] = await Promise.all([
    fetchDoctorProfile(tx, doctorCustomerId),
    fetchAssignmentsWithOutlet(tx, doctorCustomerId),
  ])

  const base = mapDoctorListItem(row.customer, row.latitude, row.longitude, null)

  return {
    ...base,
    doctor_profile: profile,
    assignments,
  }
}

// --- Doctor Profile Update ---

/** Updates or inserts a doctor_profiles record for a given customer. Validates the customer is type DOCTOR. */
export async function updateDoctorProfile(
  tx: Transaction,
  doctorCustomerId: string,
  input: UpdateDoctorProfileInput
): Promise<ReturnType<typeof mapDoctorProfileToResponse>> {
  const [customer] = await tx
    .select({ id: masterCustomer.id, customerType: masterCustomer.customerType })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.id, doctorCustomerId),
        eq(masterCustomer.isDeleted, false)
      )
    )

  if (!customer) {
    throw new ServiceError('DOCTOR_NOT_FOUND', `Doctor '${doctorCustomerId}' not found`, 404)
  }
  if (customer.customerType !== 'DOCTOR') {
    throw new ServiceError('INVALID_CUSTOMER_TYPE', 'Customer is not of type DOCTOR', 400)
  }

  const [existing] = await tx
    .select()
    .from(doctorProfiles)
    .where(eq(doctorProfiles.customerId, doctorCustomerId))

  if (existing) {
    const values: Record<string, unknown> = { updatedAt: sql`NOW()` }
    if (input.sip_str_number !== undefined) values.sipStrNumber = input.sip_str_number
    if (input.specialization !== undefined) values.specialization = input.specialization
    if (input.sub_specialization !== undefined) values.subSpecialization = input.sub_specialization
    if (input.practice_schedule !== undefined) values.practiceSchedule = input.practice_schedule
    if (input.notes !== undefined) values.notes = input.notes

    const [updated] = await tx
      .update(doctorProfiles)
      .set(values)
      .where(eq(doctorProfiles.id, existing.id))
      .returning()

    if (!updated) throw new Error('Update returned no rows')
    return mapDoctorProfileToResponse(updated)
  }

  // Insert new profile — derive companyId from the customer record
  const [customerFull] = await tx
    .select({ companyId: masterCustomer.companyId })
    .from(masterCustomer)
    .where(eq(masterCustomer.id, doctorCustomerId))

  const [inserted] = await tx
    .insert(doctorProfiles)
    .values({
      companyId: customerFull!.companyId,
      customerId: doctorCustomerId,
      sipStrNumber: input.sip_str_number ?? null,
      specialization: input.specialization ?? null,
      subSpecialization: input.sub_specialization ?? null,
      practiceSchedule: input.practice_schedule ?? null,
      notes: input.notes ?? null,
    })
    .returning()

  if (!inserted) throw new Error('Insert returned no rows')
  return mapDoctorProfileToResponse(inserted)
}

// --- Assignment CRUD ---

/** Lists all active (non-deleted) assignments for a doctor with outlet summary embedded. */
export async function listAssignments(
  tx: Transaction,
  doctorCustomerId: string
): Promise<{ data: DoctorOutletAssignmentResponseType[] }> {
  await assertDoctorExists(tx, doctorCustomerId)
  const assignments = await fetchAssignmentsWithOutlet(tx, doctorCustomerId)
  return { data: assignments }
}

/** Creates a new doctor-outlet assignment. Validates doctor/outlet existence and no duplicates. */
export async function createAssignment(
  tx: Transaction,
  companyId: string,
  doctorCustomerId: string,
  input: CreateAssignmentInput
): Promise<DoctorOutletAssignmentResponseType> {
  await assertDoctorExists(tx, doctorCustomerId)
  await assertOutletExists(tx, input.outlet_customer_id)

  if (input.is_primary_practice) {
    await clearPrimaryAssignment(tx, doctorCustomerId)
  }

  try {
    const [row] = await tx
      .insert(doctorOutletAssignments)
      .values({
        companyId,
        doctorCustomerId,
        outletCustomerId: input.outlet_customer_id,
        roomOrDepartment: input.room_or_department ?? null,
        isPrimaryPractice: input.is_primary_practice ?? false,
        practiceDays: input.practice_days ?? null,
        practiceHoursStart: input.practice_hours_start ?? null,
        practiceHoursEnd: input.practice_hours_end ?? null,
        isActive: input.is_active ?? true,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')

    const outlet = await fetchOutletSummary(tx, input.outlet_customer_id)
    return mapAssignmentToResponse(row, outlet)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        'ASSIGNMENT_ALREADY_EXISTS',
        `Doctor is already assigned to this outlet`,
        409
      )
    }
    throw err
  }
}

/** Partially updates an existing assignment. Handles is_primary_practice flag clearing. */
export async function updateAssignment(
  tx: Transaction,
  assignmentId: string,
  input: UpdateAssignmentInput
): Promise<DoctorOutletAssignmentResponseType> {
  const [existing] = await tx
    .select()
    .from(doctorOutletAssignments)
    .where(
      and(
        eq(doctorOutletAssignments.id, assignmentId),
        eq(doctorOutletAssignments.isDeleted, false)
      )
    )

  if (!existing) {
    throw new ServiceError('ASSIGNMENT_NOT_FOUND', `Assignment '${assignmentId}' not found`, 404)
  }

  if (input.is_primary_practice) {
    await clearPrimaryAssignment(tx, existing.doctorCustomerId, assignmentId)
  }

  const values: Record<string, unknown> = { updatedAt: sql`NOW()` }
  if (input.room_or_department !== undefined) values.roomOrDepartment = input.room_or_department
  if (input.is_primary_practice !== undefined) values.isPrimaryPractice = input.is_primary_practice
  if (input.practice_days !== undefined) values.practiceDays = input.practice_days
  if (input.practice_hours_start !== undefined) values.practiceHoursStart = input.practice_hours_start
  if (input.practice_hours_end !== undefined) values.practiceHoursEnd = input.practice_hours_end
  if (input.is_active !== undefined) values.isActive = input.is_active

  const [updated] = await tx
    .update(doctorOutletAssignments)
    .set(values)
    .where(eq(doctorOutletAssignments.id, assignmentId))
    .returning()

  if (!updated) throw new Error('Update returned no rows')

  const outlet = await fetchOutletSummary(tx, updated.outletCustomerId)
  return mapAssignmentToResponse(updated, outlet)
}

/** Soft-deletes an assignment. */
export async function deleteAssignment(
  tx: Transaction,
  assignmentId: string,
  deletedBy: string
): Promise<void> {
  const [row] = await tx
    .update(doctorOutletAssignments)
    .set({ isDeleted: true, deletedAt: sql`NOW()`, deletedBy, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(doctorOutletAssignments.id, assignmentId),
        eq(doctorOutletAssignments.isDeleted, false)
      )
    )
    .returning({ id: doctorOutletAssignments.id })

  if (!row) {
    throw new ServiceError('ASSIGNMENT_NOT_FOUND', `Assignment '${assignmentId}' not found`, 404)
  }
}

// --- Internal Helpers ---

function buildDoctorFilters(params: ListDoctorsParams) {
  const conditions = [
    eq(masterCustomer.customerType, 'DOCTOR'),
    eq(masterCustomer.isDeleted, false),
  ]

  if (params.search) {
    conditions.push(
      or(
        ilike(masterCustomer.name, `%${params.search}%`),
        ilike(doctorProfiles.sipStrNumber, `%${params.search}%`)
      )!
    )
  }
  if (params.specialization) {
    conditions.push(ilike(doctorProfiles.specialization, `%${params.specialization}%`))
  }
  if (params.is_active !== undefined) {
    conditions.push(eq(masterCustomer.isActive, params.is_active))
  }
  if (params.soffice_id) {
    conditions.push(eq(masterCustomer.sofficeId, params.soffice_id))
  }

  return conditions
}

async function assertDoctorExists(tx: Transaction, doctorCustomerId: string): Promise<void> {
  const [row] = await tx
    .select({ id: masterCustomer.id })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.id, doctorCustomerId),
        eq(masterCustomer.customerType, 'DOCTOR'),
        eq(masterCustomer.isDeleted, false)
      )
    )

  if (!row) {
    throw new ServiceError('DOCTOR_NOT_FOUND', `Doctor '${doctorCustomerId}' not found`, 404)
  }
}

async function assertOutletExists(tx: Transaction, outletCustomerId: string): Promise<void> {
  const [row] = await tx
    .select({ id: masterCustomer.id })
    .from(masterCustomer)
    .where(
      and(
        eq(masterCustomer.id, outletCustomerId),
        eq(masterCustomer.customerType, 'OUTLET'),
        eq(masterCustomer.isDeleted, false)
      )
    )

  if (!row) {
    throw new ServiceError('OUTLET_NOT_FOUND', `Outlet '${outletCustomerId}' not found`, 404)
  }
}

async function clearPrimaryAssignment(
  tx: Transaction,
  doctorCustomerId: string,
  excludeAssignmentId?: string
): Promise<void> {
  const conditions = [
    eq(doctorOutletAssignments.doctorCustomerId, doctorCustomerId),
    eq(doctorOutletAssignments.isPrimaryPractice, true),
    eq(doctorOutletAssignments.isDeleted, false),
  ]
  if (excludeAssignmentId) {
    conditions.push(ne(doctorOutletAssignments.id, excludeAssignmentId))
  }

  await tx
    .update(doctorOutletAssignments)
    .set({ isPrimaryPractice: false, updatedAt: sql`NOW()` })
    .where(and(...conditions))
}

async function fetchDoctorProfile(
  tx: Transaction,
  customerId: string
): Promise<ReturnType<typeof mapDoctorProfileToResponse> | null> {
  const [row] = await tx
    .select()
    .from(doctorProfiles)
    .where(eq(doctorProfiles.customerId, customerId))

  if (!row) return null
  return mapDoctorProfileToResponse(row)
}

async function fetchOutletSummary(
  tx: Transaction,
  outletCustomerId: string
) {
  const latCol = sql<number | null>`ST_Y(${masterCustomer.locationGeom})::float`.as('latitude')
  const lngCol = sql<number | null>`ST_X(${masterCustomer.locationGeom})::float`.as('longitude')

  const [row] = await tx
    .select({
      id: masterCustomer.id,
      name: masterCustomer.name,
      address: masterCustomer.address,
      city: masterCustomer.city,
      latitude: latCol,
      longitude: lngCol,
    })
    .from(masterCustomer)
    .where(eq(masterCustomer.id, outletCustomerId))

  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    address: row.address ?? null,
    city: row.city ?? null,
    latitude: row.latitude,
    longitude: row.longitude,
  }
}

async function fetchAssignmentsWithOutlet(
  tx: Transaction,
  doctorCustomerId: string
): Promise<DoctorOutletAssignmentResponseType[]> {
  const latCol = sql<number | null>`ST_Y(outlet.location_geom)::float`.as('outlet_latitude')
  const lngCol = sql<number | null>`ST_X(outlet.location_geom)::float`.as('outlet_longitude')

  const rows = await tx
    .select({
      assignment: doctorOutletAssignments,
      outletId: sql<string>`outlet.id`.as('outlet_id'),
      outletName: sql<string>`outlet.name`.as('outlet_name'),
      outletAddress: sql<string | null>`outlet.address`.as('outlet_address'),
      outletCity: sql<string | null>`outlet.city`.as('outlet_city'),
      outletLatitude: latCol,
      outletLongitude: lngCol,
    })
    .from(doctorOutletAssignments)
    .innerJoin(
      sql`master_customer AS outlet`,
      sql`outlet.id = ${doctorOutletAssignments.outletCustomerId}`
    )
    .where(
      and(
        eq(doctorOutletAssignments.doctorCustomerId, doctorCustomerId),
        eq(doctorOutletAssignments.isDeleted, false)
      )
    )
    .orderBy(doctorOutletAssignments.createdAt)

  return rows.map((r) =>
    mapAssignmentToResponse(r.assignment, {
      id: r.outletId,
      name: r.outletName,
      address: r.outletAddress ?? null,
      city: r.outletCity ?? null,
      latitude: r.outletLatitude,
      longitude: r.outletLongitude,
    })
  )
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}
