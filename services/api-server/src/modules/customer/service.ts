import { eq, and, ilike, or, count, sql, ne } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { masterCustomer, doctorProfiles, masterPic } from '../../db/schema/customer'
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  ListCustomersParams,
  CustomerResponseType,
  CustomerDetailResponseType,
  CreatePicInput,
  UpdatePicInput,
  PicResponseType,
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

// --- Mappers ---

type CustomerRow = typeof masterCustomer.$inferSelect

function mapCustomerToResponse(
  row: CustomerRow,
  latitude: number | null,
  longitude: number | null
): CustomerResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    soffice_id: row.sofficeId,
    customer_type: row.customerType,
    erp_customer_code: row.erpCustomerCode ?? null,
    name: row.name,
    customer_group: row.customerGroup ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    latitude,
    longitude,
    credit_limit: row.creditLimit ? Number(row.creditLimit) : null,
    credit_term_days: row.creditTermDays ?? null,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

type PicRow = typeof masterPic.$inferSelect

function mapPicToResponse(row: PicRow): PicResponseType {
  return {
    id: row.id,
    customer_id: row.customerId,
    pic_name: row.picName,
    position_title: row.positionTitle ?? null,
    phone: row.phone ?? null,
    is_primary: row.isPrimary ?? false,
    created_at: row.createdAt ?? new Date().toISOString(),
  }
}

// --- Customer CRUD ---

/** Creates a new customer record. If type is DOCTOR and doctor_profile provided, also inserts profile. */
export async function createCustomer(
  tx: Transaction,
  companyId: string,
  input: CreateCustomerInput
): Promise<CustomerResponseType> {
  const locationValue = input.location
    ? sql`ST_SetSRID(ST_MakePoint(${input.location.longitude}, ${input.location.latitude}), 4326)`
    : null

  try {
    const [row] = await tx
      .insert(masterCustomer)
      .values({
        companyId,
        sofficeId: input.soffice_id,
        customerType: input.customer_type,
        erpCustomerCode: input.erp_customer_code ?? null,
        name: input.name,
        customerGroup: input.customer_group ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        locationGeom: locationValue,
        creditLimit: input.credit_limit?.toString() ?? '0',
        creditTermDays: input.credit_term_days ?? 30,
        isActive: input.is_active ?? true,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')

    if (input.customer_type === 'DOCTOR' && input.doctor_profile) {
      await insertDoctorProfile(tx, companyId, row.id, input.doctor_profile)
    }

    return mapCustomerToResponse(row, input.location?.latitude ?? null, input.location?.longitude ?? null)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ServiceError('CUSTOMER_CODE_EXISTS', `ERP code '${input.erp_customer_code}' already exists`, 409)
    }
    throw err
  }
}

/** Lists non-deleted customers with pagination, search, and filters. */
export async function listCustomers(
  tx: Transaction,
  params: ListCustomersParams
): Promise<{ data: CustomerResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const conditions = buildCustomerFilters(params)
  const whereClause = and(...conditions)

  const latCol = sql<number | null>`ST_Y(${masterCustomer.locationGeom})::float`.as('latitude')
  const lngCol = sql<number | null>`ST_X(${masterCustomer.locationGeom})::float`.as('longitude')

  const [rows, totalResult] = await Promise.all([
    tx
      .select({ customer: masterCustomer, latitude: latCol, longitude: lngCol })
      .from(masterCustomer)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(masterCustomer.createdAt),
    tx.select({ total: count() }).from(masterCustomer).where(whereClause),
  ])

  return {
    data: rows.map((r) => mapCustomerToResponse(r.customer, r.latitude, r.longitude)),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

/** Retrieves a single customer with PICs and doctor profile (detail view). */
export async function getCustomerById(
  tx: Transaction,
  id: string
): Promise<CustomerDetailResponseType> {
  const latCol = sql<number | null>`ST_Y(${masterCustomer.locationGeom})::float`.as('latitude')
  const lngCol = sql<number | null>`ST_X(${masterCustomer.locationGeom})::float`.as('longitude')

  const [row] = await tx
    .select({ customer: masterCustomer, latitude: latCol, longitude: lngCol })
    .from(masterCustomer)
    .where(and(eq(masterCustomer.id, id), eq(masterCustomer.isDeleted, false)))

  if (!row) {
    throw new ServiceError('CUSTOMER_NOT_FOUND', `Customer '${id}' not found`, 404)
  }

  const [pics, doctorProfile] = await Promise.all([
    fetchPicsForCustomer(tx, id),
    fetchDoctorProfile(tx, id),
  ])

  const base = mapCustomerToResponse(row.customer, row.latitude, row.longitude)

  return { ...base, pics, doctor_profile: doctorProfile }
}

/** Partially updates customer fields. Handles location and doctor_profile upsert. */
export async function updateCustomer(
  tx: Transaction,
  id: string,
  input: UpdateCustomerInput
): Promise<CustomerResponseType> {
  const values: Record<string, unknown> = { updatedAt: sql`NOW()` }

  if (input.name !== undefined) values.name = input.name
  if (input.erp_customer_code !== undefined) values.erpCustomerCode = input.erp_customer_code
  if (input.customer_group !== undefined) values.customerGroup = input.customer_group
  if (input.address !== undefined) values.address = input.address
  if (input.city !== undefined) values.city = input.city
  if (input.credit_limit !== undefined) values.creditLimit = input.credit_limit?.toString() ?? '0'
  if (input.credit_term_days !== undefined) values.creditTermDays = input.credit_term_days
  if (input.is_active !== undefined) values.isActive = input.is_active
  if (input.location !== undefined) {
    values.locationGeom = input.location
      ? sql`ST_SetSRID(ST_MakePoint(${input.location.longitude}, ${input.location.latitude}), 4326)`
      : null
  }

  try {
    const [row] = await tx
      .update(masterCustomer)
      .set(values)
      .where(and(eq(masterCustomer.id, id), eq(masterCustomer.isDeleted, false)))
      .returning()

    if (!row) {
      throw new ServiceError('CUSTOMER_NOT_FOUND', `Customer '${id}' not found`, 404)
    }

    if (input.doctor_profile && row.customerType === 'DOCTOR') {
      await upsertDoctorProfile(tx, row.companyId, id, input.doctor_profile)
    }

    const lat = input.location?.latitude ?? null
    const lng = input.location?.longitude ?? null
    return mapCustomerToResponse(row, lat, lng)
  } catch (err: unknown) {
    if (err instanceof ServiceError) throw err
    if (isUniqueViolation(err)) {
      throw new ServiceError('CUSTOMER_CODE_EXISTS', `ERP code '${input.erp_customer_code}' already exists`, 409)
    }
    throw err
  }
}

/** Soft-deletes a customer and its related PICs. */
export async function deleteCustomer(
  tx: Transaction,
  id: string,
  deletedBy: string
): Promise<void> {
  const [row] = await tx
    .update(masterCustomer)
    .set({ isDeleted: true, deletedAt: sql`NOW()`, deletedBy, updatedAt: sql`NOW()` })
    .where(and(eq(masterCustomer.id, id), eq(masterCustomer.isDeleted, false)))
    .returning({ id: masterCustomer.id })

  if (!row) {
    throw new ServiceError('CUSTOMER_NOT_FOUND', `Customer '${id}' not found`, 404)
  }

  await tx
    .update(masterPic)
    .set({ isDeleted: true, deletedAt: sql`NOW()`, deletedBy })
    .where(and(eq(masterPic.customerId, id), eq(masterPic.isDeleted, false)))
}

// --- PIC Management ---

/** Lists non-deleted PICs for a customer. */
export async function listPics(
  tx: Transaction,
  customerId: string
): Promise<{ data: PicResponseType[] }> {
  await assertCustomerExists(tx, customerId)

  const rows = await tx
    .select()
    .from(masterPic)
    .where(and(eq(masterPic.customerId, customerId), eq(masterPic.isDeleted, false)))
    .orderBy(masterPic.createdAt)

  return { data: rows.map(mapPicToResponse) }
}

/** Creates a new PIC for a customer. If is_primary, clears other primary flags. */
export async function createPic(
  tx: Transaction,
  companyId: string,
  customerId: string,
  input: CreatePicInput
): Promise<PicResponseType> {
  await assertCustomerExists(tx, customerId)

  if (input.is_primary) {
    await clearPrimaryPic(tx, customerId)
  }

  const [row] = await tx
    .insert(masterPic)
    .values({
      companyId,
      customerId,
      picName: input.pic_name,
      positionTitle: input.position_title ?? null,
      phone: input.phone ?? null,
      isPrimary: input.is_primary ?? false,
    })
    .returning()

  if (!row) throw new Error('Insert returned no rows')
  return mapPicToResponse(row)
}

/** Partially updates a PIC record. If is_primary set to true, clears other primary flags. */
export async function updatePic(
  tx: Transaction,
  picId: string,
  input: UpdatePicInput
): Promise<PicResponseType> {
  const [existing] = await tx
    .select()
    .from(masterPic)
    .where(and(eq(masterPic.id, picId), eq(masterPic.isDeleted, false)))

  if (!existing) {
    throw new ServiceError('PIC_NOT_FOUND', `PIC '${picId}' not found`, 404)
  }

  if (input.is_primary) {
    await clearPrimaryPic(tx, existing.customerId, picId)
  }

  const values: Record<string, unknown> = {}
  if (input.pic_name !== undefined) values.picName = input.pic_name
  if (input.position_title !== undefined) values.positionTitle = input.position_title
  if (input.phone !== undefined) values.phone = input.phone
  if (input.is_primary !== undefined) values.isPrimary = input.is_primary

  const [row] = await tx
    .update(masterPic)
    .set(values)
    .where(eq(masterPic.id, picId))
    .returning()

  if (!row) throw new Error('Update returned no rows')
  return mapPicToResponse(row)
}

/** Soft-deletes a PIC record. */
export async function deletePic(
  tx: Transaction,
  picId: string,
  deletedBy: string
): Promise<void> {
  const [row] = await tx
    .update(masterPic)
    .set({ isDeleted: true, deletedAt: sql`NOW()`, deletedBy })
    .where(and(eq(masterPic.id, picId), eq(masterPic.isDeleted, false)))
    .returning({ id: masterPic.id })

  if (!row) {
    throw new ServiceError('PIC_NOT_FOUND', `PIC '${picId}' not found`, 404)
  }
}

// --- Internal Helpers ---

function buildCustomerFilters(params: ListCustomersParams) {
  const conditions = [eq(masterCustomer.isDeleted, false)]

  if (params.search) {
    conditions.push(
      or(
        ilike(masterCustomer.name, `%${params.search}%`),
        ilike(masterCustomer.erpCustomerCode, `%${params.search}%`),
        ilike(masterCustomer.city, `%${params.search}%`)
      )!
    )
  }
  if (params.customer_type) {
    conditions.push(eq(masterCustomer.customerType, params.customer_type))
  }
  if (params.is_active !== undefined) {
    conditions.push(eq(masterCustomer.isActive, params.is_active))
  }
  if (params.soffice_id) {
    conditions.push(eq(masterCustomer.sofficeId, params.soffice_id))
  }
  if (params.city) {
    conditions.push(ilike(masterCustomer.city, `%${params.city}%`))
  }

  return conditions
}

async function assertCustomerExists(tx: Transaction, customerId: string): Promise<void> {
  const [row] = await tx
    .select({ id: masterCustomer.id })
    .from(masterCustomer)
    .where(and(eq(masterCustomer.id, customerId), eq(masterCustomer.isDeleted, false)))

  if (!row) {
    throw new ServiceError('CUSTOMER_NOT_FOUND', `Customer '${customerId}' not found`, 404)
  }
}

async function clearPrimaryPic(tx: Transaction, customerId: string, excludePicId?: string): Promise<void> {
  const conditions = [
    eq(masterPic.customerId, customerId),
    eq(masterPic.isPrimary, true),
    eq(masterPic.isDeleted, false),
  ]
  if (excludePicId) {
    conditions.push(ne(masterPic.id, excludePicId))
  }

  await tx
    .update(masterPic)
    .set({ isPrimary: false })
    .where(and(...conditions))
}

async function insertDoctorProfile(
  tx: Transaction,
  companyId: string,
  customerId: string,
  profile: NonNullable<CreateCustomerInput['doctor_profile']>
): Promise<void> {
  await tx.insert(doctorProfiles).values({
    companyId,
    customerId,
    sipStrNumber: profile.sip_str_number ?? null,
    specialization: profile.specialization ?? null,
    subSpecialization: profile.sub_specialization ?? null,
    practiceSchedule: profile.practice_schedule ?? null,
    notes: profile.notes ?? null,
  })
}

async function upsertDoctorProfile(
  tx: Transaction,
  companyId: string,
  customerId: string,
  profile: NonNullable<UpdateCustomerInput['doctor_profile']>
): Promise<void> {
  const [existing] = await tx
    .select({ id: doctorProfiles.id })
    .from(doctorProfiles)
    .where(eq(doctorProfiles.customerId, customerId))

  const values: Record<string, unknown> = { updatedAt: sql`NOW()` }
  if (profile.sip_str_number !== undefined) values.sipStrNumber = profile.sip_str_number
  if (profile.specialization !== undefined) values.specialization = profile.specialization
  if (profile.sub_specialization !== undefined) values.subSpecialization = profile.sub_specialization
  if (profile.practice_schedule !== undefined) values.practiceSchedule = profile.practice_schedule
  if (profile.notes !== undefined) values.notes = profile.notes

  if (existing) {
    await tx.update(doctorProfiles).set(values).where(eq(doctorProfiles.id, existing.id))
  } else {
    await tx.insert(doctorProfiles).values({
      companyId,
      customerId,
      sipStrNumber: profile.sip_str_number ?? null,
      specialization: profile.specialization ?? null,
      subSpecialization: profile.sub_specialization ?? null,
      practiceSchedule: profile.practice_schedule ?? null,
      notes: profile.notes ?? null,
    })
  }
}

async function fetchPicsForCustomer(tx: Transaction, customerId: string): Promise<PicResponseType[]> {
  const rows = await tx
    .select()
    .from(masterPic)
    .where(and(eq(masterPic.customerId, customerId), eq(masterPic.isDeleted, false)))
    .orderBy(masterPic.createdAt)

  return rows.map(mapPicToResponse)
}

async function fetchDoctorProfile(
  tx: Transaction,
  customerId: string
): Promise<CustomerDetailResponseType['doctor_profile']> {
  const [row] = await tx
    .select()
    .from(doctorProfiles)
    .where(eq(doctorProfiles.customerId, customerId))

  if (!row) return null

  return {
    id: row.id,
    sip_str_number: row.sipStrNumber ?? null,
    specialization: row.specialization ?? null,
    sub_specialization: row.subSpecialization ?? null,
    practice_schedule: (row.practiceSchedule as Record<string, unknown>) ?? null,
    notes: row.notes ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}
