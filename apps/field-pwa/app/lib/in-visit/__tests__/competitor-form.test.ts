import { describe, expect, it } from 'vitest'
import {
  COMPETITOR_BRAND_MAX_LENGTH,
  COMPETITOR_PRODUCT_MAX_LENGTH,
  buildCompetitorAuditPayload,
  createEmptyCompetitorForm,
  isCompetitorFormValid,
  validateCompetitorForm,
  type CompetitorFormState
} from '../competitor-form'

/** Build a form state from partial overrides atop a blank form. */
function formWith(overrides: Partial<CompetitorFormState> = {}): CompetitorFormState {
  return { ...createEmptyCompetitorForm(), ...overrides }
}

/** A minimally valid form (both required text fields filled). */
function validForm(overrides: Partial<CompetitorFormState> = {}): CompetitorFormState {
  return formWith({ competitorBrand: 'Kalbe', competitorProduct: 'Promag', ...overrides })
}

describe('competitor-form', () => {
  describe('createEmptyCompetitorForm', () => {
    it('should return a blank, submittable-once-filled state', () => {
      expect(createEmptyCompetitorForm()).toEqual({
        competitorBrand: '',
        competitorProduct: '',
        priceToPharmacy: null,
        consumerPrice: null,
        activePromoNotes: ''
      })
    })
  })

  describe('validateCompetitorForm', () => {
    it('should require a competitor brand', () => {
      expect(validateCompetitorForm(validForm({ competitorBrand: '' })).competitorBrand).toBeDefined()
      expect(validateCompetitorForm(validForm({ competitorBrand: '   ' })).competitorBrand).toBeDefined()
    })

    it('should require a competitor product', () => {
      expect(validateCompetitorForm(validForm({ competitorProduct: '' })).competitorProduct).toBeDefined()
      expect(validateCompetitorForm(validForm({ competitorProduct: '   ' })).competitorProduct).toBeDefined()
    })

    it('should accept a valid form with null prices and no errors', () => {
      expect(validateCompetitorForm(validForm())).toEqual({})
    })

    it('should reject brand longer than the backend varchar(150) limit', () => {
      const tooLong = 'a'.repeat(COMPETITOR_BRAND_MAX_LENGTH + 1)
      expect(validateCompetitorForm(validForm({ competitorBrand: tooLong })).competitorBrand).toBeDefined()
    })

    it('should reject product longer than the backend varchar(150) limit', () => {
      const tooLong = 'a'.repeat(COMPETITOR_PRODUCT_MAX_LENGTH + 1)
      expect(validateCompetitorForm(validForm({ competitorProduct: tooLong })).competitorProduct).toBeDefined()
    })

    it('should accept brand and product exactly at the max length', () => {
      const atBrand = 'a'.repeat(COMPETITOR_BRAND_MAX_LENGTH)
      const atProduct = 'b'.repeat(COMPETITOR_PRODUCT_MAX_LENGTH)
      expect(validateCompetitorForm(validForm({ competitorBrand: atBrand, competitorProduct: atProduct }))).toEqual({})
    })

    it('should reject a negative price to pharmacy', () => {
      expect(validateCompetitorForm(validForm({ priceToPharmacy: -1 })).priceToPharmacy).toBeDefined()
    })

    it('should reject a negative consumer price', () => {
      expect(validateCompetitorForm(validForm({ consumerPrice: -0.5 })).consumerPrice).toBeDefined()
    })

    it('should accept zero and positive prices', () => {
      expect(validateCompetitorForm(validForm({ priceToPharmacy: 0, consumerPrice: 15000 }))).toEqual({})
    })
  })

  describe('isCompetitorFormValid', () => {
    it('should be false when required fields are blank and true once filled', () => {
      expect(isCompetitorFormValid(formWith())).toBe(false)
      expect(isCompetitorFormValid(validForm())).toBe(true)
    })
  })

  describe('buildCompetitorAuditPayload', () => {
    it('should trim brand/product and match the backend CreateCompetitorAuditBody contract', () => {
      const payload = buildCompetitorAuditPayload(
        validForm({
          competitorBrand: '  Kalbe Farma  ',
          competitorProduct: '  Promag Tablet  ',
          priceToPharmacy: 12000,
          consumerPrice: 15000,
          activePromoNotes: '  Diskon 10%  '
        })
      )
      expect(payload).toEqual({
        competitor_brand: 'Kalbe Farma',
        competitor_product: 'Promag Tablet',
        price_to_pharmacy: 12000,
        consumer_price: 15000,
        active_promo_notes: 'Diskon 10%'
      })
    })

    it('should collapse empty promo notes to null', () => {
      const payload = buildCompetitorAuditPayload(validForm({ activePromoNotes: '   ' }))
      expect(payload.active_promo_notes).toBeNull()
    })

    it('should pass through null prices unchanged', () => {
      const payload = buildCompetitorAuditPayload(validForm())
      expect(payload.price_to_pharmacy).toBeNull()
      expect(payload.consumer_price).toBeNull()
    })
  })
})
