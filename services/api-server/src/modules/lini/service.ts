import { eq, and, ilike, or, count, sql, inArray } from 'drizzle-orm'

import type { Transaction } from '../../db'
import { masterLini, masterVarian } from '../../db/schema/tenant'
import { userLiniAssignments } from '../../db/schema/auth'
import type {
  CreateLiniInput,
  UpdateLiniInput,
  ListLiniParams,
  LiniResponseType,
  CreateVarianInput,
  UpdateVarianInput,
  ListVarianParams,
  VarianResponseType,
  ListUserLiniParams,
  UserLiniAssignmentResponseType,
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

type LiniRow = typeof masterLini.$inferSelect
type VarianRow = typeof masterVarian.$inferSelect

// --- Lini Mappers ---

function mapLiniToResponse(row: LiniRow): LiniResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

// --- Varian Mappers ---

function mapVarianToResponse(row: VarianRow): VarianResponseType {
  return {
    id: row.id,
    company_id: row.companyId,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

// --- Lini CRUD ---

/** Creates a new business line (lini) within the current tenant transaction. */
export async function createLini(
  tx: Transaction,
  companyId: string,
  input: CreateLiniInput
): Promise<LiniResponseType> {
  try {
    const [row] = await tx
      .insert(masterLini)
      .values({
        companyId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        isActive: input.is_active ?? true,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapLiniToResponse(row)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ServiceError('LINI_CODE_EXISTS', `Lini code '${input.code}' already exists`, 409)
    }
    throw err
  }
}

/** Lists non-deleted lini records with pagination, search, and active filter. */
export async function listLini(
  tx: Transaction,
  params: ListLiniParams
): Promise<{ data: LiniResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const conditions = [eq(masterLini.isDeleted, false)]
  if (params.search) {
    conditions.push(
      or(
        ilike(masterLini.code, `%${params.search}%`),
        ilike(masterLini.name, `%${params.search}%`)
      )!
    )
  }
  if (params.is_active !== undefined) {
    conditions.push(eq(masterLini.isActive, params.is_active))
  }

  const whereClause = and(...conditions)

  const [rows, totalResult] = await Promise.all([
    tx.select().from(masterLini).where(whereClause).limit(limit).offset(offset).orderBy(masterLini.createdAt),
    tx.select({ total: count() }).from(masterLini).where(whereClause),
  ])

  return {
    data: rows.map(mapLiniToResponse),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

/** Retrieves a single non-deleted lini by ID. */
export async function getLiniById(
  tx: Transaction,
  id: string
): Promise<LiniResponseType> {
  const [row] = await tx
    .select()
    .from(masterLini)
    .where(and(eq(masterLini.id, id), eq(masterLini.isDeleted, false)))

  if (!row) {
    throw new ServiceError('LINI_NOT_FOUND', `Lini '${id}' not found`, 404)
  }
  return mapLiniToResponse(row)
}

/** Partially updates editable fields on a lini record. */
export async function updateLini(
  tx: Transaction,
  id: string,
  input: UpdateLiniInput
): Promise<LiniResponseType> {
  const values: Record<string, unknown> = { updatedAt: sql`NOW()` }

  if (input.code !== undefined) values.code = input.code
  if (input.name !== undefined) values.name = input.name
  if (input.description !== undefined) values.description = input.description
  if (input.is_active !== undefined) values.isActive = input.is_active

  try {
    const [row] = await tx
      .update(masterLini)
      .set(values)
      .where(and(eq(masterLini.id, id), eq(masterLini.isDeleted, false)))
      .returning()

    if (!row) {
      throw new ServiceError('LINI_NOT_FOUND', `Lini '${id}' not found`, 404)
    }
    return mapLiniToResponse(row)
  } catch (err: unknown) {
    if (err instanceof ServiceError) throw err
    if (isUniqueViolation(err)) {
      throw new ServiceError('LINI_CODE_EXISTS', `Lini code '${input.code}' already exists`, 409)
    }
    throw err
  }
}

/** Soft-deletes a lini record by setting is_deleted, deleted_at, and deleted_by. */
export async function deleteLini(
  tx: Transaction,
  id: string,
  deletedBy: string
): Promise<void> {
  const [row] = await tx
    .update(masterLini)
    .set({
      isDeleted: true,
      deletedAt: sql`NOW()`,
      deletedBy,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(masterLini.id, id), eq(masterLini.isDeleted, false)))
    .returning({ id: masterLini.id })

  if (!row) {
    throw new ServiceError('LINI_NOT_FOUND', `Lini '${id}' not found`, 404)
  }
}

// --- Varian CRUD ---

/** Creates a new product variant within the current tenant transaction. */
export async function createVarian(
  tx: Transaction,
  companyId: string,
  input: CreateVarianInput
): Promise<VarianResponseType> {
  try {
    const [row] = await tx
      .insert(masterVarian)
      .values({
        companyId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        isActive: input.is_active ?? true,
      })
      .returning()

    if (!row) throw new Error('Insert returned no rows')
    return mapVarianToResponse(row)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ServiceError('VARIAN_CODE_EXISTS', `Varian code '${input.code}' already exists`, 409)
    }
    throw err
  }
}

/** Lists non-deleted varian records with pagination, search, and active filter. */
export async function listVarian(
  tx: Transaction,
  params: ListVarianParams
): Promise<{ data: VarianResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const conditions = [eq(masterVarian.isDeleted, false)]
  if (params.search) {
    conditions.push(
      or(
        ilike(masterVarian.code, `%${params.search}%`),
        ilike(masterVarian.name, `%${params.search}%`)
      )!
    )
  }
  if (params.is_active !== undefined) {
    conditions.push(eq(masterVarian.isActive, params.is_active))
  }

  const whereClause = and(...conditions)

  const [rows, totalResult] = await Promise.all([
    tx.select().from(masterVarian).where(whereClause).limit(limit).offset(offset).orderBy(masterVarian.createdAt),
    tx.select({ total: count() }).from(masterVarian).where(whereClause),
  ])

  return {
    data: rows.map(mapVarianToResponse),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

/** Retrieves a single non-deleted varian by ID. */
export async function getVarianById(
  tx: Transaction,
  id: string
): Promise<VarianResponseType> {
  const [row] = await tx
    .select()
    .from(masterVarian)
    .where(and(eq(masterVarian.id, id), eq(masterVarian.isDeleted, false)))

  if (!row) {
    throw new ServiceError('VARIAN_NOT_FOUND', `Varian '${id}' not found`, 404)
  }
  return mapVarianToResponse(row)
}

/** Partially updates editable fields on a varian record. */
export async function updateVarian(
  tx: Transaction,
  id: string,
  input: UpdateVarianInput
): Promise<VarianResponseType> {
  const values: Record<string, unknown> = { updatedAt: sql`NOW()` }

  if (input.code !== undefined) values.code = input.code
  if (input.name !== undefined) values.name = input.name
  if (input.description !== undefined) values.description = input.description
  if (input.is_active !== undefined) values.isActive = input.is_active

  try {
    const [row] = await tx
      .update(masterVarian)
      .set(values)
      .where(and(eq(masterVarian.id, id), eq(masterVarian.isDeleted, false)))
      .returning()

    if (!row) {
      throw new ServiceError('VARIAN_NOT_FOUND', `Varian '${id}' not found`, 404)
    }
    return mapVarianToResponse(row)
  } catch (err: unknown) {
    if (err instanceof ServiceError) throw err
    if (isUniqueViolation(err)) {
      throw new ServiceError('VARIAN_CODE_EXISTS', `Varian code '${input.code}' already exists`, 409)
    }
    throw err
  }
}

/** Soft-deletes a varian record by setting is_deleted, deleted_at, and deleted_by. */
export async function deleteVarian(
  tx: Transaction,
  id: string,
  deletedBy: string
): Promise<void> {
  const [row] = await tx
    .update(masterVarian)
    .set({
      isDeleted: true,
      deletedAt: sql`NOW()`,
      deletedBy,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(masterVarian.id, id), eq(masterVarian.isDeleted, false)))
    .returning({ id: masterVarian.id })

  if (!row) {
    throw new ServiceError('VARIAN_NOT_FOUND', `Varian '${id}' not found`, 404)
  }
}

// --- User-Lini Assignment CRUD ---

/** Lists lini assignments for a specific user, joined with lini details. */
export async function listUserLiniAssignments(
  tx: Transaction,
  userId: string,
  params: ListUserLiniParams
): Promise<{ data: UserLiniAssignmentResponseType[] }> {
  const conditions = [eq(userLiniAssignments.userId, userId)]
  if (params.is_active !== undefined) {
    conditions.push(eq(userLiniAssignments.isActive, params.is_active))
  }

  const rows = await tx
    .select({
      id: userLiniAssignments.id,
      companyId: userLiniAssignments.companyId,
      userId: userLiniAssignments.userId,
      liniId: userLiniAssignments.liniId,
      isActive: userLiniAssignments.isActive,
      createdAt: userLiniAssignments.createdAt,
      liniCode: masterLini.code,
      liniName: masterLini.name,
    })
    .from(userLiniAssignments)
    .innerJoin(masterLini, eq(userLiniAssignments.liniId, masterLini.id))
    .where(and(...conditions))
    .orderBy(masterLini.name)

  return {
    data: rows.map((row) => ({
      id: row.id,
      company_id: row.companyId,
      user_id: row.userId,
      lini_id: row.liniId,
      lini_code: row.liniCode,
      lini_name: row.liniName,
      is_active: row.isActive ?? true,
      created_at: row.createdAt ?? new Date().toISOString(),
    })),
  }
}

/** Assigns one or more lini to a user, skipping existing assignments. */
export async function assignUserLini(
  tx: Transaction,
  companyId: string,
  userId: string,
  liniIds: string[]
): Promise<UserLiniAssignmentResponseType[]> {
  const values = liniIds.map((liniId) => ({
    companyId,
    userId,
    liniId,
    isActive: true,
  }))

  const rows = await tx
    .insert(userLiniAssignments)
    .values(values)
    .onConflictDoNothing({ target: [userLiniAssignments.companyId, userLiniAssignments.userId, userLiniAssignments.liniId] })
    .returning()

  if (rows.length === 0) {
    return []
  }

  // Fetch with lini details for response
  const inserted = await tx
    .select({
      id: userLiniAssignments.id,
      companyId: userLiniAssignments.companyId,
      userId: userLiniAssignments.userId,
      liniId: userLiniAssignments.liniId,
      isActive: userLiniAssignments.isActive,
      createdAt: userLiniAssignments.createdAt,
      liniCode: masterLini.code,
      liniName: masterLini.name,
    })
    .from(userLiniAssignments)
    .innerJoin(masterLini, eq(userLiniAssignments.liniId, masterLini.id))
    .where(
      inArray(
        userLiniAssignments.id,
        rows.map((r) => r.id)
      )
    )

  return inserted.map((row) => ({
    id: row.id,
    company_id: row.companyId,
    user_id: row.userId,
    lini_id: row.liniId,
    lini_code: row.liniCode,
    lini_name: row.liniName,
    is_active: row.isActive ?? true,
    created_at: row.createdAt ?? new Date().toISOString(),
  }))
}

/** Removes a specific lini assignment from a user (physical delete). */
export async function removeUserLiniAssignment(
  tx: Transaction,
  userId: string,
  liniId: string
): Promise<void> {
  const [row] = await tx
    .delete(userLiniAssignments)
    .where(
      and(
        eq(userLiniAssignments.userId, userId),
        eq(userLiniAssignments.liniId, liniId)
      )
    )
    .returning({ id: userLiniAssignments.id })

  if (!row) {
    throw new ServiceError(
      'USER_LINI_NOT_FOUND',
      `Lini assignment not found for user '${userId}' and lini '${liniId}'`,
      404
    )
  }
}

// --- Utilities ---

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}
