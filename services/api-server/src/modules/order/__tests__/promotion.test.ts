import { describe, it, expect } from 'bun:test'

import { computeLinePricing } from '@maction/utils'

import {
  resolveDiscountPercentage,
  resolveLineDiscount,
  promotionHasFreeGoods,
  type ActivePromotion,
} from '../promotion'

/** Builds an ActivePromotion with sensible defaults, overridable per test. */
function makePromotion(overrides: Partial<ActivePromotion>): ActivePromotion {
  return {
    id: 'promo-1',
    promoType: 'PERCENT_DISCOUNT',
    discountPercentage: 0,
    discountAmount: 0,
    minOrderQty: 1,
    freeMaterialId: null,
    freeMaterialQty: 0,
    ...overrides,
  }
}

describe('order/promotion', () => {
  describe('resolveDiscountPercentage', () => {
    it('uses a percent-discount promotion over a manual discount', () => {
      const promo = makePromotion({ promoType: 'PERCENT_DISCOUNT', discountPercentage: 15 })
      expect(resolveDiscountPercentage(5, promo)).toBe(15)
    })

    it('falls back to the manual discount when there is no promotion', () => {
      expect(resolveDiscountPercentage(7.5, null)).toBe(7.5)
    })

    it('defaults to zero when neither promotion nor manual discount is provided', () => {
      expect(resolveDiscountPercentage(undefined, null)).toBe(0)
    })

    it('ignores non-percentage promotions and uses the manual discount', () => {
      const promo = makePromotion({ id: 'promo-2', promoType: 'FREE_GOODS', minOrderQty: 10 })
      expect(resolveDiscountPercentage(3, promo)).toBe(3)
    })
  })

  describe('resolveLineDiscount', () => {
    it('PERCENT_DISCOUNT overrides manual percentage and applies no flat discount', () => {
      const promo = makePromotion({ promoType: 'PERCENT_DISCOUNT', discountPercentage: 20 })
      expect(resolveLineDiscount(5, promo)).toEqual({ discountPercentage: 20, fixedDiscountAmount: 0 })
    })

    it('FIXED_AMOUNT applies a flat discount and keeps the manual percentage', () => {
      const promo = makePromotion({ promoType: 'FIXED_AMOUNT', discountAmount: 1200 })
      expect(resolveLineDiscount(5, promo)).toEqual({ discountPercentage: 5, fixedDiscountAmount: 1200 })
    })

    it('FREE_GOODS leaves the purchased line discount untouched', () => {
      const promo = makePromotion({
        promoType: 'FREE_GOODS',
        freeMaterialId: 'mat-free',
        freeMaterialQty: 2,
        discountAmount: 999,
      })
      expect(resolveLineDiscount(4, promo)).toEqual({ discountPercentage: 4, fixedDiscountAmount: 0 })
    })

    it('BUNDLING stacks a populated percentage and flat amount', () => {
      const promo = makePromotion({ promoType: 'BUNDLING', discountPercentage: 10, discountAmount: 500 })
      expect(resolveLineDiscount(3, promo)).toEqual({ discountPercentage: 10, fixedDiscountAmount: 500 })
    })

    it('BUNDLING without a percentage keeps the manual percentage', () => {
      const promo = makePromotion({ promoType: 'BUNDLING', discountPercentage: 0, discountAmount: 500 })
      expect(resolveLineDiscount(3, promo)).toEqual({ discountPercentage: 3, fixedDiscountAmount: 500 })
    })
  })

  describe('promotionHasFreeGoods', () => {
    it('is true for FREE_GOODS with a free material and qty', () => {
      const promo = makePromotion({ promoType: 'FREE_GOODS', freeMaterialId: 'mat', freeMaterialQty: 1 })
      expect(promotionHasFreeGoods(promo)).toBe(true)
    })

    it('is true for BUNDLING carrying a free material', () => {
      const promo = makePromotion({ promoType: 'BUNDLING', freeMaterialId: 'mat', freeMaterialQty: 2 })
      expect(promotionHasFreeGoods(promo)).toBe(true)
    })

    it('is false when the free material or qty is missing', () => {
      expect(promotionHasFreeGoods(makePromotion({ promoType: 'FREE_GOODS', freeMaterialQty: 0 }))).toBe(false)
      expect(
        promotionHasFreeGoods(makePromotion({ promoType: 'FREE_GOODS', freeMaterialId: null, freeMaterialQty: 3 }))
      ).toBe(false)
    })

    it('is false for percent/fixed promos and for no promotion', () => {
      expect(promotionHasFreeGoods(makePromotion({ promoType: 'PERCENT_DISCOUNT' }))).toBe(false)
      expect(promotionHasFreeGoods(makePromotion({ promoType: 'FIXED_AMOUNT', discountAmount: 100 }))).toBe(false)
      expect(promotionHasFreeGoods(null)).toBe(false)
    })
  })

  describe('end-to-end line pricing per promo type', () => {
    const qty = 10
    const unitPrice = 1000 // gross = 10_000

    it('PERCENT_DISCOUNT reduces the line by the promo percentage', () => {
      const promo = makePromotion({ promoType: 'PERCENT_DISCOUNT', discountPercentage: 10 })
      const { discountPercentage, fixedDiscountAmount } = resolveLineDiscount(0, promo)
      const pricing = computeLinePricing({ qty, unitPrice, discountPercentage, fixedDiscountAmount })
      expect(pricing.discountAmount).toBe(1000)
      expect(pricing.subtotal).toBe(9000)
    })

    it('FIXED_AMOUNT reduces the line by a flat amount', () => {
      const promo = makePromotion({ promoType: 'FIXED_AMOUNT', discountAmount: 2500 })
      const { discountPercentage, fixedDiscountAmount } = resolveLineDiscount(0, promo)
      const pricing = computeLinePricing({ qty, unitPrice, discountPercentage, fixedDiscountAmount })
      expect(pricing.discountAmount).toBe(2500)
      expect(pricing.subtotal).toBe(7500)
    })

    it('FIXED_AMOUNT never drives the subtotal negative (capped at gross)', () => {
      const promo = makePromotion({ promoType: 'FIXED_AMOUNT', discountAmount: 999999 })
      const { discountPercentage, fixedDiscountAmount } = resolveLineDiscount(0, promo)
      const pricing = computeLinePricing({ qty, unitPrice, discountPercentage, fixedDiscountAmount })
      expect(pricing.discountAmount).toBe(10000)
      expect(pricing.subtotal).toBe(0)
    })

    it('FREE_GOODS leaves the purchased line at full price', () => {
      const promo = makePromotion({
        promoType: 'FREE_GOODS',
        freeMaterialId: 'mat-free',
        freeMaterialQty: 2,
      })
      const { discountPercentage, fixedDiscountAmount } = resolveLineDiscount(0, promo)
      const pricing = computeLinePricing({ qty, unitPrice, discountPercentage, fixedDiscountAmount })
      expect(pricing.discountAmount).toBe(0)
      expect(pricing.subtotal).toBe(10000)
      expect(promotionHasFreeGoods(promo)).toBe(true)
    })

    it('BUNDLING stacks percentage and flat discounts on the purchased line', () => {
      const promo = makePromotion({
        promoType: 'BUNDLING',
        discountPercentage: 10,
        discountAmount: 500,
        freeMaterialId: 'mat-free',
        freeMaterialQty: 1,
      })
      const { discountPercentage, fixedDiscountAmount } = resolveLineDiscount(0, promo)
      const pricing = computeLinePricing({ qty, unitPrice, discountPercentage, fixedDiscountAmount })
      expect(pricing.discountAmount).toBe(1500)
      expect(pricing.subtotal).toBe(8500)
      expect(promotionHasFreeGoods(promo)).toBe(true)
    })
  })
})
