import { Elysia, t } from 'elysia'
import * as XLSX from 'xlsx'

import { tenantGuard } from '../../middleware/tenantGuard'
import { requireRole, ALL_ROLES } from '../../middleware/roleGuard'
import { withRLS } from '../../db'
import {
  CreateCustomerBody,
  UpdateCustomerBody,
  ListCustomersQuery,
  CustomerIdParams,
  CreatePicBody,
  UpdatePicBody,
  PicIdParams,
} from './schemas'
import {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  listPics,
  createPic,
  updatePic,
  deletePic,
  ServiceError,
} from './service'
import type { CreateCustomerInput } from './schemas'

export interface BulkRowError {
  row: number
  field: string | null
  message: string
}

export interface BulkImportResult {
  imported: number
  errors: BulkRowError[]
}

/** Validates and maps a spreadsheet row to CreateCustomerInput. */
export function parseImportRow(
  row: Record<string, unknown>,
  rowIndex: number
): { input: CreateCustomerInput; errors: BulkRowError[] } {
  const errors: BulkRowError[] = []

  const customerType = String(row['customer_type'] ?? '').trim().toUpperCase()
  if (!['OUTLET', 'DOCTOR', 'COMMUNITY', 'EVENT'].includes(customerType)) {
    errors.push({ row: rowIndex, field: 'customer_type', message: `Invalid customer_type: '${row['customer_type']}'` })
  }

  const sofficeId = String(row['soffice_id'] ?? '').trim()
  if (!sofficeId) {
    errors.push({ row: rowIndex, field: 'soffice_id', message: 'soffice_id is required' })
  }

  const name = String(row['name'] ?? '').trim()
  if (!name) {
    errors.push({ row: rowIndex, field: 'name', message: 'name is required' })
  }

  const lat = row['latitude'] !== undefined && row['latitude'] !== '' ? Number(row['latitude']) : null
  const lng = row['longitude'] !== undefined && row['longitude'] !== '' ? Number(row['longitude']) : null

  if (lat !== null && (isNaN(lat) || lat < -90 || lat > 90)) {
    errors.push({ row: rowIndex, field: 'latitude', message: 'latitude must be between -90 and 90' })
  }
  if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) {
    errors.push({ row: rowIndex, field: 'longitude', message: 'longitude must be between -180 and 180' })
  }

  const creditLimit = row['credit_limit'] !== undefined && row['credit_limit'] !== '' ? Number(row['credit_limit']) : null
  if (creditLimit !== null && (isNaN(creditLimit) || creditLimit < 0)) {
    errors.push({ row: rowIndex, field: 'credit_limit', message: 'credit_limit must be a non-negative number' })
  }

  const creditTermDays = row['credit_term_days'] !== undefined && row['credit_term_days'] !== '' ? Number(row['credit_term_days']) : null
  if (creditTermDays !== null && (isNaN(creditTermDays) || creditTermDays < 0 || !Number.isInteger(creditTermDays))) {
    errors.push({ row: rowIndex, field: 'credit_term_days', message: 'credit_term_days must be a non-negative integer' })
  }

  const isActiveRaw = row['is_active']
  const isActive = isActiveRaw === undefined || isActiveRaw === ''
    ? true
    : String(isActiveRaw).toLowerCase() === 'true' || isActiveRaw === '1' || isActiveRaw === true

  const location = lat !== null && lng !== null ? { latitude: lat, longitude: lng } : undefined

  const input: CreateCustomerInput = {
    customer_type: customerType as CreateCustomerInput['customer_type'],
    soffice_id: sofficeId,
    name,
    erp_customer_code: row['erp_customer_code'] ? String(row['erp_customer_code']).trim() : undefined,
    customer_group: row['customer_group'] ? String(row['customer_group']).trim() : undefined,
    address: row['address'] ? String(row['address']).trim() : undefined,
    city: row['city'] ? String(row['city']).trim() : undefined,
    location,
    credit_limit: creditLimit ?? undefined,
    credit_term_days: creditTermDays ?? undefined,
    is_active: isActive,
  }

  return { input, errors }
}

/**
 * Processes parsed spreadsheet rows into a partial-success result: valid rows are
 * created via `createOne`, invalid rows are rejected with per-row error details, and
 * both are tallied. Persistence is injected so the reporting logic can be exercised
 * without a live database (external DB is mocked in tests).
 *
 * Row numbers are 1-based over the data rows shifted by +2 (row 1 = header).
 */
export async function processBulkImportRows(
  rows: Record<string, unknown>[],
  createOne: (input: CreateCustomerInput) => Promise<void>
): Promise<BulkImportResult> {
  const allErrors: BulkRowError[] = []
  let imported = 0

  for (let i = 0; i < rows.length; i++) {
    const rowIndex = i + 2 // row 1 = header, data starts at row 2
    const { input, errors } = parseImportRow(rows[i]!, rowIndex)

    if (errors.length > 0) {
      allErrors.push(...errors)
      continue
    }

    try {
      await createOne(input)
      imported++
    } catch (err) {
      if (err instanceof ServiceError) {
        allErrors.push({ row: rowIndex, field: null, message: err.message })
      } else {
        allErrors.push({ row: rowIndex, field: null, message: 'Unexpected error during import' })
      }
    }
  }

  return { imported, errors: allErrors }
}

export const customerRoutes = new Elysia({ prefix: '/customers' })
  .use(tenantGuard)
  .use(requireRole(...ALL_ROLES))
  .get(
    '/',
    async ({ query, claims }) => {
      const result = await withRLS(
        { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
        (tx) => listCustomers(tx, query)
      )
      return result
    },
    { query: ListCustomersQuery }
  )
  .get(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        const customer = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => getCustomerById(tx, params.id)
        )
        return { data: customer }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CustomerIdParams }
  )
  .post(
    '/',
    async ({ body, claims, set }) => {
      try {
        const customer = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => createCustomer(tx, claims!.company_id, body)
        )
        set.status = 201
        return { data: customer }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { body: CreateCustomerBody }
  )
  .patch(
    '/:id',
    async ({ params, body, claims, set }) => {
      try {
        const customer = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => updateCustomer(tx, params.id, body)
        )
        return { data: customer }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CustomerIdParams, body: UpdateCustomerBody }
  )
  .delete(
    '/:id',
    async ({ params, claims, set }) => {
      try {
        await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => deleteCustomer(tx, params.id, claims!.user_id)
        )
        return { data: { success: true } }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CustomerIdParams }
  )
  // --- PIC Sub-Resource ---
  .get(
    '/:id/pics',
    async ({ params, claims, set }) => {
      try {
        const result = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => listPics(tx, params.id)
        )
        return result
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CustomerIdParams }
  )
  .post(
    '/:id/pics',
    async ({ params, body, claims, set }) => {
      try {
        const pic = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => createPic(tx, claims!.company_id, params.id, body)
        )
        set.status = 201
        return { data: pic }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: CustomerIdParams, body: CreatePicBody }
  )
  .patch(
    '/:id/pics/:picId',
    async ({ params, body, claims, set }) => {
      try {
        const pic = await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => updatePic(tx, params.picId, body)
        )
        return { data: pic }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: PicIdParams, body: UpdatePicBody }
  )
  .delete(
    '/:id/pics/:picId',
    async ({ params, claims, set }) => {
      try {
        await withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => deletePic(tx, params.picId, claims!.user_id)
        )
        return { data: { success: true } }
      } catch (err) {
        if (err instanceof ServiceError) {
          set.status = err.status
          return { error: { code: err.code, message: err.message } }
        }
        throw err
      }
    },
    { params: PicIdParams }
  )
  // --- Bulk Import ---
  .post(
    '/bulk-import',
    async ({ body, claims, set }) => {
      const file = body.file
      if (!file) {
        set.status = 400
        return { error: { code: 'INVALID_FILE', message: 'A file field is required (XLSX or CSV)' } }
      }

      let rows: Record<string, unknown>[]
      try {
        const buffer = Buffer.from(await file.arrayBuffer())
        const workbook = XLSX.read(buffer, { type: 'buffer' })
        const sheetName = workbook.SheetNames[0]
        if (!sheetName) {
          set.status = 400
          return { error: { code: 'EMPTY_WORKBOOK', message: 'The uploaded file contains no sheets' } }
        }
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]!)
      } catch {
        set.status = 400
        return { error: { code: 'PARSE_ERROR', message: 'Unable to parse the uploaded file. Ensure it is a valid XLSX or CSV.' } }
      }

      if (rows.length === 0) {
        return { imported: 0, errors: [] }
      }

      return processBulkImportRows(rows, (input) =>
        withRLS(
          { companyId: claims!.company_id, userId: claims!.user_id, userRole: claims!.role_label },
          (tx) => createCustomer(tx, claims!.company_id, input)
        ).then(() => undefined)
      )
    },
    { body: t.Object({ file: t.File({ maxSize: '10m' }) }) }
  )
