import { eq, ilike, or, count, sql } from 'drizzle-orm'

import { db } from '../../db'
import { companies } from '../../db/schema/tenant'
import { redis } from '../../config/redis'
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
  UpdateERPConfigInput,
  ListCompaniesParams,
  CompanyResponseType,
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

type CompanyRow = typeof companies.$inferSelect

/** Maps a Drizzle camelCase row to the snake_case API response shape. */
function mapCompanyToResponse(row: CompanyRow): CompanyResponseType {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    is_active: row.isActive ?? true,
    logo_s3_key: row.logoS3Key ?? null,
    default_tax_rate: Number(row.defaultTaxRate ?? 11),
    geofence_radius_meters: row.geofenceRadiusMeters ?? 100,
    checkout_min_hour: row.checkoutMinHour ?? 16,
    erp_system_type: row.erpSystemType ?? null,
    erp_endpoint_url: row.erpEndpointUrl ?? null,
    erp_auth_config: (row.erpAuthConfig as Record<string, unknown>) ?? null,
    erp_company_code: row.erpCompanyCode ?? null,
    created_at: row.createdAt ?? new Date().toISOString(),
    updated_at: row.updatedAt ?? new Date().toISOString(),
  }
}

/** Creates a new tenant company. */
export async function createCompany(
  input: CreateCompanyInput
): Promise<CompanyResponseType> {
  try {
    const rows = await db
      .insert(companies)
      .values({
        code: input.code,
        name: input.name,
        logoS3Key: input.logo_s3_key ?? null,
        erpSystemType: input.erp_system_type ?? undefined,
        erpEndpointUrl: input.erp_endpoint_url ?? null,
        erpCompanyCode: input.erp_company_code ?? null,
        defaultTaxRate: input.default_tax_rate?.toString(),
        geofenceRadiusMeters: input.geofence_radius_meters,
        checkoutMinHour: input.checkout_min_hour,
      })
      .returning()

    const row = rows[0]
    if (!row) throw new Error('Insert returned no rows')

    return mapCompanyToResponse(row)
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        'COMPANY_CODE_EXISTS',
        `Company code '${input.code}' already exists`,
        409
      )
    }
    throw err
  }
}

/** Lists companies with optional search and pagination. */
export async function listCompanies(
  params: ListCompaniesParams
): Promise<{ data: CompanyResponseType[]; meta: { page: number; limit: number; total: number } }> {
  const page = params.page ?? 1
  const limit = params.limit ?? 20
  const offset = (page - 1) * limit

  const whereClause = params.search
    ? or(
        ilike(companies.name, `%${params.search}%`),
        ilike(companies.code, `%${params.search}%`)
      )
    : undefined

  const [rows, totalResult] = await Promise.all([
    db
      .select()
      .from(companies)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(companies.createdAt),
    db
      .select({ total: count() })
      .from(companies)
      .where(whereClause),
  ])

  return {
    data: rows.map(mapCompanyToResponse),
    meta: { page, limit, total: totalResult[0]?.total ?? 0 },
  }
}

/** Partially updates a company's editable fields. */
export async function updateCompany(
  id: string,
  input: UpdateCompanyInput
): Promise<CompanyResponseType> {
  const values: Record<string, unknown> = {
    updatedAt: sql`NOW()`,
  }

  if (input.code !== undefined) values.code = input.code
  if (input.name !== undefined) values.name = input.name
  if (input.logo_s3_key !== undefined) values.logoS3Key = input.logo_s3_key
  if (input.default_tax_rate !== undefined)
    values.defaultTaxRate = input.default_tax_rate.toString()
  if (input.geofence_radius_meters !== undefined)
    values.geofenceRadiusMeters = input.geofence_radius_meters
  if (input.checkout_min_hour !== undefined)
    values.checkoutMinHour = input.checkout_min_hour

  try {
    const [row] = await db
      .update(companies)
      .set(values)
      .where(eq(companies.id, id))
      .returning()

    if (!row) {
      throw new ServiceError('COMPANY_NOT_FOUND', `Company '${id}' not found`, 404)
    }

    return mapCompanyToResponse(row)
  } catch (err: unknown) {
    if (err instanceof ServiceError) throw err
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        'COMPANY_CODE_EXISTS',
        `Company code '${input.code}' already exists`,
        409
      )
    }
    throw err
  }
}

/** Updates a company's ERP gateway configuration fields. */
export async function updateERPConfig(
  id: string,
  input: UpdateERPConfigInput
): Promise<CompanyResponseType> {
  const [row] = await db
    .update(companies)
    .set({
      erpSystemType: input.erp_system_type,
      erpEndpointUrl: input.erp_endpoint_url ?? null,
      erpAuthConfig: input.erp_auth_config ?? null,
      erpCompanyCode: input.erp_company_code ?? null,
      updatedAt: sql`NOW()`,
    })
    .where(eq(companies.id, id))
    .returning()

  if (!row) {
    throw new ServiceError('COMPANY_NOT_FOUND', `Company '${id}' not found`, 404)
  }

  return mapCompanyToResponse(row)
}

/** Deactivates a company and invalidates all its Redis sessions (kill-switch). */
export async function deactivateCompany(id: string): Promise<void> {
  const [row] = await db
    .update(companies)
    .set({ isActive: false, updatedAt: sql`NOW()` })
    .where(eq(companies.id, id))
    .returning({ id: companies.id })

  if (!row) {
    throw new ServiceError('COMPANY_NOT_FOUND', `Company '${id}' not found`, 404)
  }

  await invalidateCompanySessions(id)
}

/** Scans and deletes all Redis session keys belonging to a company. */
async function invalidateCompanySessions(companyId: string): Promise<void> {
  const pattern = `session:${companyId}:*`
  let cursor = '0'

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      100
    )
    cursor = nextCursor

    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } while (cursor !== '0')
}

/** Checks whether a database error is a unique constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  )
}
