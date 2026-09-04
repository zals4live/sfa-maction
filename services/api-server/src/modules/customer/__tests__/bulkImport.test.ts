import { describe, it, expect } from 'bun:test'
import * as XLSX from 'xlsx'

import { ServiceError } from '../service'
import type { CreateCustomerInput } from '../schemas'

// Must set env before importing routes (transitively loads tenantGuard, which reads
// JWT_SECRET at module load). Static ESM imports are hoisted, so the route module is
// pulled in via top-level dynamic import AFTER the env is set — mirroring the pattern
// used by other module route tests (e.g. order/__tests__/routes.test.ts).
process.env['JWT_SECRET'] = 'test-secret-key-for-unit-tests'

const { parseImportRow, processBulkImportRows } = await import('../routes')

/**
 * Phase 16 integration test — bulk customer import partial-success reporting.
 *
 * The bulk-import endpoint (`POST /customers/bulk-import`) parses an XLSX/CSV upload
 * and reports partial success: valid rows are imported, invalid rows are rejected
 * with per-row error details, and the response tallies imported vs failed rows.
 *
 * The persistence layer (Drizzle + PostgreSQL behind `withRLS` → `createCustomer`) is
 * an injected `createOne` callback here, so the reporting logic is exercised without a
 * live database — external services are mocked per project testing conventions. The
 * XLSX round-trip uses the real `xlsx` library the route depends on, proving the
 * parse → validate → report pipeline end-to-end.
 */

const SOFFICE_ID = '11111111-1111-1111-1111-111111111111'

/** Builds an XLSX file buffer from an array of row objects (row 1 = header). */
function buildWorkbookRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const parsed = XLSX.read(buffer, { type: 'buffer' })
  const sheetName = parsed.SheetNames[0]!
  return XLSX.utils.sheet_to_json(parsed.Sheets[sheetName]!)
}

/** A creator that records every input it was asked to persist. */
function recordingCreator() {
  const created: CreateCustomerInput[] = []
  const createOne = async (input: CreateCustomerInput): Promise<void> => {
    created.push(input)
  }
  return { created, createOne }
}

describe('customer/bulk-import — parseImportRow', () => {
  it('accepts a fully valid OUTLET row with no errors', () => {
    const { input, errors } = parseImportRow(
      { customer_type: 'outlet', soffice_id: SOFFICE_ID, name: 'Apotek Sehat', city: 'Jakarta' },
      2
    )
    expect(errors).toHaveLength(0)
    expect(input.customer_type).toBe('OUTLET')
    expect(input.name).toBe('Apotek Sehat')
    expect(input.soffice_id).toBe(SOFFICE_ID)
  })

  it('flags an invalid customer_type, missing name, and missing soffice_id', () => {
    const { errors } = parseImportRow({ customer_type: 'PHARMACY', name: '' }, 5)
    const fields = errors.map((e) => e.field).sort()
    expect(fields).toEqual(['customer_type', 'name', 'soffice_id'])
    expect(errors.every((e) => e.row === 5)).toBe(true)
  })

  it('rejects out-of-range latitude/longitude', () => {
    const { errors } = parseImportRow(
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'X', latitude: 200, longitude: -999 },
      3
    )
    const fields = errors.map((e) => e.field)
    expect(fields).toContain('latitude')
    expect(fields).toContain('longitude')
  })

  it('rejects a negative credit_limit and non-integer credit_term_days', () => {
    const { errors } = parseImportRow(
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'X', credit_limit: -5, credit_term_days: 3.5 },
      4
    )
    const fields = errors.map((e) => e.field)
    expect(fields).toContain('credit_limit')
    expect(fields).toContain('credit_term_days')
  })
})

describe('customer/bulk-import — processBulkImportRows partial success', () => {
  it('imports valid rows, rejects invalid rows, and reports accurate counts', async () => {
    const rows = buildWorkbookRows([
      // row 2 — valid
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'Apotek A', city: 'Bandung' },
      // row 3 — invalid customer_type
      { customer_type: 'CLINIC', soffice_id: SOFFICE_ID, name: 'Bad Type' },
      // row 4 — valid DOCTOR
      { customer_type: 'DOCTOR', soffice_id: SOFFICE_ID, name: 'dr. Budi' },
      // row 5 — missing name
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: '' },
    ])

    const { created, createOne } = recordingCreator()
    const result = await processBulkImportRows(rows, createOne)

    // Two valid rows imported, two invalid rows rejected.
    expect(result.imported).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(created).toHaveLength(2)
    expect(created.map((c) => c.name)).toEqual(['Apotek A', 'dr. Budi'])

    // Per-row error details point at the correct 1-based (header-shifted) rows.
    const errorRows = result.errors.map((e) => e.row).sort()
    expect(errorRows).toEqual([3, 5])
    const badType = result.errors.find((e) => e.row === 3)
    expect(badType?.field).toBe('customer_type')
    const missingName = result.errors.find((e) => e.row === 5)
    expect(missingName?.field).toBe('name')
  })

  it('reports a persistence ServiceError (e.g. duplicate ERP code) as a per-row error', async () => {
    const rows = buildWorkbookRows([
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'Unique One', erp_customer_code: 'ERP-1' },
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'Dup', erp_customer_code: 'ERP-DUP' },
    ])

    // Simulate the DB rejecting the second row with a unique-violation ServiceError.
    let call = 0
    const createOne = async (): Promise<void> => {
      call++
      if (call === 2) {
        throw new ServiceError('CUSTOMER_CODE_EXISTS', "ERP code 'ERP-DUP' already exists", 409)
      }
    }

    const result = await processBulkImportRows(rows, createOne)

    expect(result.imported).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      row: 3,
      field: null,
      message: "ERP code 'ERP-DUP' already exists",
    })
  })

  it('maps an unexpected (non-ServiceError) failure to a generic per-row message', async () => {
    const rows = buildWorkbookRows([
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'Boom' },
    ])
    const createOne = async (): Promise<void> => {
      throw new Error('connection reset')
    }

    const result = await processBulkImportRows(rows, createOne)

    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ row: 2, field: null, message: 'Unexpected error during import' })
  })

  it('reports all-valid and all-invalid datasets correctly', async () => {
    const allValid = buildWorkbookRows([
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'A' },
      { customer_type: 'OUTLET', soffice_id: SOFFICE_ID, name: 'B' },
    ])
    const validResult = await processBulkImportRows(allValid, recordingCreator().createOne)
    expect(validResult.imported).toBe(2)
    expect(validResult.errors).toHaveLength(0)

    const allInvalid = buildWorkbookRows([
      { customer_type: 'NOPE', soffice_id: '', name: '' },
    ])
    const { created, createOne } = recordingCreator()
    const invalidResult = await processBulkImportRows(allInvalid, createOne)
    expect(invalidResult.imported).toBe(0)
    expect(created).toHaveLength(0)
    // One row, three field errors (customer_type, soffice_id, name).
    expect(invalidResult.errors.map((e) => e.field).sort()).toEqual(['customer_type', 'name', 'soffice_id'])
  })
})
