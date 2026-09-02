import { describe, expect, it } from 'vitest'
import {
  STOCK_AUDIT_UOM_MAX_LENGTH,
  buildStockAuditPayload,
  createEmptyStockAuditForm,
  isStockAuditFormValid,
  validateStockAuditForm,
  type StockAuditFormState
} from '../stock-audit-form'

/** Build a form state from partial overrides atop a blank form. */
function formWith(overrides: Partial<StockAuditFormState> = {}): StockAuditFormState {
  return { ...createEmptyStockAuditForm(), ...overrides }
}

/** A minimally valid form (material chosen, qty + uom filled). */
function validForm(overrides: Partial<StockAuditFormState> = {}): StockAuditFormState {
  return formWith({ materialId: 'mat-1', physicalStockQty: 10, uom: 'Box', ...overrides })
}

describe('stock-audit-form', () => {
  describe('createEmptyStockAuditForm', () => {
    it('should return a blank state', () => {
      expect(createEmptyStockAuditForm()).toEqual({
        materialId: null,
        physicalStockQty: null,
        uom: '',
        estimatedDaysOfStock: null
      })
    })
  })

  describe('validateStockAuditForm', () => {
    it('should require a material', () => {
      expect(validateStockAuditForm(validForm({ materialId: null })).materialId).toBeDefined()
    })

    it('should require a physical stock quantity', () => {
      expect(validateStockAuditForm(validForm({ physicalStockQty: null })).physicalStockQty).toBeDefined()
    })

    it('should reject a negative physical stock quantity', () => {
      expect(validateStockAuditForm(validForm({ physicalStockQty: -1 })).physicalStockQty).toBeDefined()
    })

    it('should reject a non-integer physical stock quantity', () => {
      expect(validateStockAuditForm(validForm({ physicalStockQty: 1.5 })).physicalStockQty).toBeDefined()
    })

    it('should accept a zero physical stock quantity', () => {
      expect(validateStockAuditForm(validForm({ physicalStockQty: 0 }))).toEqual({})
    })

    it('should require a UOM', () => {
      expect(validateStockAuditForm(validForm({ uom: '' })).uom).toBeDefined()
      expect(validateStockAuditForm(validForm({ uom: '   ' })).uom).toBeDefined()
    })

    it('should reject a UOM longer than the backend varchar(20) limit', () => {
      const tooLong = 'a'.repeat(STOCK_AUDIT_UOM_MAX_LENGTH + 1)
      expect(validateStockAuditForm(validForm({ uom: tooLong })).uom).toBeDefined()
    })

    it('should accept a UOM exactly at the max length', () => {
      const atMax = 'a'.repeat(STOCK_AUDIT_UOM_MAX_LENGTH)
      expect(validateStockAuditForm(validForm({ uom: atMax }))).toEqual({})
    })

    it('should treat estimated days of stock as optional', () => {
      expect(validateStockAuditForm(validForm({ estimatedDaysOfStock: null }))).toEqual({})
    })

    it('should reject a negative estimated days of stock', () => {
      expect(validateStockAuditForm(validForm({ estimatedDaysOfStock: -3 })).estimatedDaysOfStock).toBeDefined()
    })

    it('should reject a non-integer estimated days of stock', () => {
      expect(validateStockAuditForm(validForm({ estimatedDaysOfStock: 2.5 })).estimatedDaysOfStock).toBeDefined()
    })

    it('should accept a valid form with no errors', () => {
      expect(validateStockAuditForm(validForm({ estimatedDaysOfStock: 7 }))).toEqual({})
    })
  })

  describe('isStockAuditFormValid', () => {
    it('should be false when required fields are blank and true once filled', () => {
      expect(isStockAuditFormValid(formWith())).toBe(false)
      expect(isStockAuditFormValid(validForm())).toBe(true)
    })
  })

  describe('buildStockAuditPayload', () => {
    it('should trim the UOM and match the backend CreateStockAuditBody contract', () => {
      const payload = buildStockAuditPayload(
        validForm({ materialId: 'mat-9', physicalStockQty: 24, uom: '  Strip  ', estimatedDaysOfStock: 14 })
      )
      expect(payload).toEqual({
        material_id: 'mat-9',
        physical_stock_qty: 24,
        uom: 'Strip',
        estimated_days_of_stock: 14
      })
    })

    it('should pass through a null estimated days of stock unchanged', () => {
      const payload = buildStockAuditPayload(validForm())
      expect(payload.estimated_days_of_stock).toBeNull()
    })
  })
})
