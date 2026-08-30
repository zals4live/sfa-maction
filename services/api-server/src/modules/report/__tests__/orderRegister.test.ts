import { describe, it, expect } from 'bun:test'

import {
  buildOrderConditions,
  resolvePagination,
  mapOrderRow,
  type OrderRecord,
} from '../orderRegister'

const baseRecord: OrderRecord = {
  orderId: 'o-1',
  orderNumber: 'ORD-20250615-0001',
  userId: 'u-1',
  customerId: 'c-1',
  sofficeId: 's-1',
  status: 'SUBMITTED',
  totalAmount: '1250000.00',
  createdAt: '2025-06-15T08:30:00.000Z',
}

describe('report/orderRegister — buildOrderConditions', () => {
  it('should always scope to the tenant company', () => {
    const conditions = buildOrderConditions({}, 'company-1')
    expect(conditions).toHaveLength(1)
  })

  it('should add one condition per supplied optional filter', () => {
    const conditions = buildOrderConditions(
      {
        user_id: 'u-1',
        soffice_id: 's-1',
        customer_id: 'c-1',
        status: 'SUBMITTED',
        lini_id: 'l-1',
        date_from: '2025-06-01',
        date_to: '2025-06-30',
        min_total: 100000,
        max_total: 5000000,
      },
      'company-1'
    )
    // company + user + soffice + customer + status + date_from + date_to
    // + min_total + max_total + lini
    expect(conditions).toHaveLength(10)
  })

  it('should omit conditions for absent filters', () => {
    const conditions = buildOrderConditions({ user_id: 'u-1' }, 'company-1')
    expect(conditions).toHaveLength(2)
  })

  it('should treat a zero min_total as an active filter', () => {
    const conditions = buildOrderConditions({ min_total: 0 }, 'company-1')
    expect(conditions).toHaveLength(2)
  })

  it('should treat a zero max_total as an active filter', () => {
    const conditions = buildOrderConditions({ max_total: 0 }, 'company-1')
    expect(conditions).toHaveLength(2)
  })

  it('should add a lini condition via the EXISTS sub-query', () => {
    const conditions = buildOrderConditions({ lini_id: 'l-1' }, 'company-1')
    expect(conditions).toHaveLength(2)
  })
})

describe('report/orderRegister — resolvePagination', () => {
  it('should default page to 1 and limit to 20', () => {
    expect(resolvePagination({})).toEqual({ page: 1, limit: 20, offset: 0 })
  })

  it('should compute offset from page and limit', () => {
    expect(resolvePagination({ page: 3, limit: 10 })).toEqual({
      page: 3,
      limit: 10,
      offset: 20,
    })
  })

  it('should yield a zero offset on the first page', () => {
    expect(resolvePagination({ page: 1, limit: 50 }).offset).toBe(0)
  })
})

describe('report/orderRegister — mapOrderRow', () => {
  it('should map camelCase columns to the snake_case response shape', () => {
    expect(mapOrderRow(baseRecord)).toEqual({
      order_id: 'o-1',
      order_number: 'ORD-20250615-0001',
      user_id: 'u-1',
      customer_id: 'c-1',
      soffice_id: 's-1',
      status: 'SUBMITTED',
      total_amount: 1250000,
      created_at: '2025-06-15T08:30:00.000Z',
    })
  })

  it('should coerce the numeric-string grand total to a number', () => {
    const row = mapOrderRow({ ...baseRecord, totalAmount: '999.99' })
    expect(row.total_amount).toBe(999.99)
    expect(typeof row.total_amount).toBe('number')
  })

  it('should default a null total to 0', () => {
    expect(mapOrderRow({ ...baseRecord, totalAmount: null }).total_amount).toBe(0)
  })

  it('should coalesce a null status to the DB default DRAFT', () => {
    expect(mapOrderRow({ ...baseRecord, status: null }).status).toBe('DRAFT')
  })

  it('should normalize created_at to an ISO date-time string', () => {
    const row = mapOrderRow({ ...baseRecord, createdAt: '2025-06-15 08:30:00+00' })
    expect(row.created_at).toBe('2025-06-15T08:30:00.000Z')
  })

  it('should fall back to the epoch for a null created_at', () => {
    const row = mapOrderRow({ ...baseRecord, createdAt: null })
    expect(row.created_at).toBe(new Date(0).toISOString())
  })
})
