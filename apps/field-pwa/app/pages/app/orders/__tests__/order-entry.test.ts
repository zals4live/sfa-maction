import { describe, it, expect } from 'vitest'
import { BusinessLine } from '@maction/types'
import type { MasterCustomer, MasterMaterial } from '@maction/types'
import { businessLinesFor, dedupeMaterials, toCustomerOptions } from '../order-entry'

/** Build a customer from partial overrides atop an active, non-deleted default. */
function makeCustomer(overrides: Partial<MasterCustomer> = {}): MasterCustomer {
  return {
    id: 'cust-1',
    company_id: 'co-1',
    soffice_id: 'so-1',
    customer_type: 'OUTLET' as MasterCustomer['customer_type'],
    code: 'C001',
    name: 'Apotek Sehat',
    address: null,
    city: null,
    province: null,
    phone: null,
    email: null,
    location_geom: null,
    erp_customer_code: null,
    credit_limit: null,
    credit_used: null,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides
  }
}

/** Build a material from partial overrides (only fields the helpers read matter). */
function makeMaterial(overrides: Partial<MasterMaterial> = {}): MasterMaterial {
  return {
    id: 'mat-1',
    company_id: 'co-1',
    name: 'Paracetamol',
    business_line: BusinessLine.PHARMA,
    base_uom: 'Pcs',
    uom_conversion_rules: {},
    ...overrides
  } as MasterMaterial
}

describe('order-entry', () => {
  describe('toCustomerOptions', () => {
    it('should project a customer into a code-prefixed label keyed by id', () => {
      expect(toCustomerOptions([makeCustomer()])).toEqual([
        { id: 'cust-1', name: 'C001 — Apotek Sehat' }
      ])
    })

    it('should drop inactive and soft-deleted customers', () => {
      const rows = [
        makeCustomer({ id: 'a' }),
        makeCustomer({ id: 'b', is_active: false }),
        makeCustomer({ id: 'c', is_deleted: true })
      ]
      expect(toCustomerOptions(rows).map(option => option.id)).toEqual(['a'])
    })

    it('should return an empty list when there are no customers', () => {
      expect(toCustomerOptions([])).toEqual([])
    })
  })

  describe('dedupeMaterials', () => {
    it('should keep the first occurrence of each material id, preserving order', () => {
      const rows = [
        makeMaterial({ id: 'm1', name: 'First' }),
        makeMaterial({ id: 'm2', name: 'Second' }),
        makeMaterial({ id: 'm1', name: 'Duplicate' })
      ]
      const unique = dedupeMaterials(rows)
      expect(unique.map(m => m.id)).toEqual(['m1', 'm2'])
      expect(unique[0]?.name).toBe('First')
    })

    it('should return an empty list for an empty catalog', () => {
      expect(dedupeMaterials([])).toEqual([])
    })
  })

  describe('businessLinesFor', () => {
    it('should de-duplicate assigned business lines', () => {
      const lines = [BusinessLine.PHARMA, BusinessLine.OTC_HERBAL, BusinessLine.PHARMA]
      expect(businessLinesFor(lines)).toEqual([BusinessLine.PHARMA, BusinessLine.OTC_HERBAL])
    })
  })
})
