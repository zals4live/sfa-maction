/**
 * Pure promotion/discount resolution logic for order lines.
 *
 * These functions are intentionally free of any database or Drizzle imports so
 * they can be unit-tested in isolation. Loading a promotion row and enforcing
 * its validity window / min-qty lives in the order service (which owns the DB
 * transaction); this module only decides how a resolved promotion translates
 * into line discounts and free-goods eligibility.
 *
 * Supported promo types (mirrors promo_type_enum): PERCENT_DISCOUNT,
 * FIXED_AMOUNT, FREE_GOODS, BUNDLING.
 */

/** Active promotion row narrowed to fields used for discounting. */
export interface ActivePromotion {
  id: string
  promoType: string
  discountPercentage: number
  discountAmount: number
  minOrderQty: number
  freeMaterialId: string | null
  freeMaterialQty: number
}

/** The percentage + flat discount a promotion contributes to a purchased line. */
export interface LineDiscount {
  discountPercentage: number
  fixedDiscountAmount: number
}

/**
 * Determines the effective line discount percentage. A PERCENT_DISCOUNT (or a
 * BUNDLING promo carrying a percentage) takes precedence over a manually supplied
 * discount; otherwise the manual value (or 0) applies.
 */
export function resolveDiscountPercentage(
  manualDiscount: number | undefined,
  promotion: ActivePromotion | null
): number {
  if (promotion && promotionHasPercentage(promotion)) {
    return promotion.discountPercentage
  }
  return manualDiscount ?? 0
}

/**
 * Resolves the percentage and flat discounts applied to the purchased line:
 * - PERCENT_DISCOUNT: promotion percentage overrides the manual discount.
 * - FIXED_AMOUNT: flat `discountAmount` reduction (capped later at line gross).
 * - FREE_GOODS: no change to the purchased line (handled as a separate free line).
 * - BUNDLING: whichever of percentage/flat fields are populated stack together.
 */
export function resolveLineDiscount(
  manualDiscount: number | undefined,
  promotion: ActivePromotion | null
): LineDiscount {
  return {
    discountPercentage: resolveDiscountPercentage(manualDiscount, promotion),
    fixedDiscountAmount: resolveFixedDiscountAmount(promotion),
  }
}

/** Flat discount amount a FIXED_AMOUNT or BUNDLING promo contributes (else 0). */
function resolveFixedDiscountAmount(promotion: ActivePromotion | null): number {
  if (!promotion) return 0
  if (promotion.promoType === 'FIXED_AMOUNT' || promotion.promoType === 'BUNDLING') {
    return promotion.discountAmount
  }
  return 0
}

/** Whether a promotion supplies a percentage discount (PERCENT_DISCOUNT or BUNDLING). */
function promotionHasPercentage(promotion: ActivePromotion): boolean {
  if (promotion.promoType === 'PERCENT_DISCOUNT') return true
  return promotion.promoType === 'BUNDLING' && promotion.discountPercentage > 0
}

/** Whether a promotion generates a free-goods line (FREE_GOODS or BUNDLING with a free material). */
export function promotionHasFreeGoods(promotion: ActivePromotion | null): boolean {
  if (!promotion) return false
  const applicableType = promotion.promoType === 'FREE_GOODS' || promotion.promoType === 'BUNDLING'
  return applicableType && promotion.freeMaterialId != null && promotion.freeMaterialQty > 0
}
