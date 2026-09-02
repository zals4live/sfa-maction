import { describe, expect, it } from 'vitest'
import type { UOMConversionRules } from '@maction/types'
import {
  buildCartItemInput,
  createEmptyOrderCartForm,
  isOrderCartFormValid,
  resolveUomMultiplier,
  toBaseQty,
  validateOrderCartForm,
  type OrderCartFormState
} from '../order-cart-form'

/** Build a form state from partial overrides atop a blank form. */
function formWith(overrides: Partial<OrderCartFormState> = {}): OrderCartFormState {
  return { ...createEmptyOrderCartForm(), ...overrides }
}

/** A minimally valid add-line form (material chosen, positive qty, uom filled). */
function validForm(overrides: Partial<OrderCartFormState> = {}): OrderCartFormState {
  return formWith({ materialId: 'mat-1', qty: 2, uom: 'Box', ...overrides })
}

/** A material stub whose conversion rules express UOMs relative to the base unit. */
const material = {
  id: 'mat-1',
  name: 'Paracetamol 500mg',
  base_uom: 'Pcs',
  uom_conversion_rules: { Strip: 10, Box: 100 } as UOMConversionRules
}

describe('order-cart-form', () => {
  describe('createEmptyOrderCartForm', () => {
    it('should return a blank state', () => {
      expect(createEmptyOrderCartForm()).toEqual({
        materialId: null,
        qty: null,
        uom: '',
        discountAmount: null
      })
    })
  })

  describe('resolveUomMultiplier', () => {
    it('should treat the base uom as a multiplier of 1', () => {
      expect(resolveUomMultiplier('Pcs', 'Pcs', material.uom_conversion_rules)).toBe(1)
    })

    it('should resolve a conversion uom to its declared multiplier', () => {
      expect(resolveUomMultiplier('Box', 'Pcs', material.uom_conversion_rules)).toBe(100)
    })

    it('should return null for an unknown uom', () => {
      expect(resolveUomMultiplier('Karton', 'Pcs', material.uom_conversion_rules)).toBeNull()
    })

    it('should reject a non-positive multiplier as unresolvable', () => {
      expect(resolveUomMultiplier('Bad', 'Pcs', { Bad: 0 })).toBeNull()
    })
  })

  describe('toBaseQty', () => {
    it('should convert a conversion-uom qty into base units', () => {
      expect(toBaseQty(3, 'Box', 'Pcs', material.uom_conversion_rules)).toBe(300)
    })

    it('should pass a base-uom qty through unchanged', () => {
      expect(toBaseQty(7, 'Pcs', 'Pcs', material.uom_conversion_rules)).toBe(7)
    })

    it('should return null for an unresolvable uom', () => {
      expect(toBaseQty(1, 'Karton', 'Pcs', material.uom_conversion_rules)).toBeNull()
    })
  })

  describe('validateOrderCartForm', () => {
    it('should require a material', () => {
      expect(validateOrderCartForm(validForm({ materialId: null })).materialId).toBeDefined()
    })

    it('should require a quantity', () => {
      expect(validateOrderCartForm(validForm({ qty: null })).qty).toBeDefined()
    })

    it('should reject a zero or negative quantity', () => {
      expect(validateOrderCartForm(validForm({ qty: 0 })).qty).toBeDefined()
      expect(validateOrderCartForm(validForm({ qty: -2 })).qty).toBeDefined()
    })

    it('should reject a non-integer quantity', () => {
      expect(validateOrderCartForm(validForm({ qty: 1.5 })).qty).toBeDefined()
    })

    it('should require a uom', () => {
      expect(validateOrderCartForm(validForm({ uom: '' })).uom).toBeDefined()
      expect(validateOrderCartForm(validForm({ uom: '  ' })).uom).toBeDefined()
    })

    it('should treat discount as optional', () => {
      expect(validateOrderCartForm(validForm({ discountAmount: null }))).toEqual({})
    })

    it('should reject a negative discount', () => {
      expect(validateOrderCartForm(validForm({ discountAmount: -1 })).discountAmount).toBeDefined()
    })

    it('should accept a valid form with no errors', () => {
      expect(validateOrderCartForm(validForm({ discountAmount: 5000 }))).toEqual({})
    })
  })

  describe('isOrderCartFormValid', () => {
    it('should be false when blank and true once filled', () => {
      expect(isOrderCartFormValid(formWith())).toBe(false)
      expect(isOrderCartFormValid(validForm())).toBe(true)
    })
  })

  describe('buildCartItemInput', () => {
    it('should build a CartItemInput with the converted base qty and price', () => {
      const input = buildCartItemInput(validForm({ qty: 2, uom: 'Box', discountAmount: 1000 }), material, 500)
      expect(input).toEqual({
        material_id: 'mat-1',
        material_name: 'Paracetamol 500mg',
        qty: 2,
        uom: 'Box',
        base_qty: 200,
        price_per_base_uom: 500,
        discount_amount: 1000
      })
    })

    it('should default a missing discount to zero', () => {
      const input = buildCartItemInput(validForm({ discountAmount: null }), material, 500)
      expect(input?.discount_amount).toBe(0)
    })

    it('should return null when the uom cannot be converted', () => {
      expect(buildCartItemInput(validForm({ uom: 'Karton' }), material, 500)).toBeNull()
    })
  })
})
