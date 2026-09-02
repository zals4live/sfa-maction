/**
 * Pure form logic for the in-visit order cart (`OrderCart.vue`) — SALESMAN only.
 *
 * Extracted from the SFC so the add-line validation and the multi-tier UOM → base-quantity
 * conversion can be unit tested in the framework-agnostic `node` Vitest environment (the PWA
 * has no DOM test harness). The component stays a thin presentational shell that binds inputs
 * to {@link OrderCartFormState} and delegates every decision here; the cart *state*, money
 * totals, persistence, and submission all live in `useCartStore`, which this helper never
 * touches — it only prepares the {@link CartItemInput}-shaped payload the store's `addItem`
 * expects.
 *
 * UOM conversion mirrors `master_material.uom_conversion_rules` (`@maction/types`): the map
 * gives each UOM code's multiplier RELATIVE TO the base unit, so `base_qty = qty × multiplier`
 * and the `base_uom` itself is an implicit multiplier of 1. Pricing is expressed per base
 * UOM (`price_per_base_uom`), matching `master_price`, so line money is derived downstream in
 * the store from `base_qty × price_per_base_uom`.
 */
import type { CartItemInput } from '../../stores/useCartStore'
import type { UOMConversionRules } from '@maction/types'

/** Reactive fields captured by the add-to-cart form in `OrderCart.vue`. */
export interface OrderCartFormState {
  /** Chosen material — required; the id of a lini-scoped `MasterMaterial`. */
  materialId: string | null
  /** Order quantity in the selected UOM — required, positive integer. */
  qty: number | null
  /** Unit of measure the quantity is expressed in — required (base or a conversion UOM). */
  uom: string
  /** Optional flat discount amount applied to the line, or `null` when none. */
  discountAmount: number | null
}

/** A field-keyed set of validation messages; empty object means the line may be added. */
export type OrderCartFormErrors = Partial<Record<keyof OrderCartFormState, string>>

/** A blank add-line form — the initial value and the post-add reset target. */
export function createEmptyOrderCartForm(): OrderCartFormState {
  return {
    materialId: null,
    qty: null,
    uom: '',
    discountAmount: null
  }
}

/**
 * Resolve a UOM's multiplier relative to the base unit from a material's conversion rules.
 * The `base_uom` is always 1; any other UOM must appear in `uom_conversion_rules`. Returns
 * `null` for an unknown UOM so callers can reject rather than silently mis-price a line.
 */
export function resolveUomMultiplier(
  uom: string,
  baseUom: string,
  rules: UOMConversionRules
): number | null {
  if (uom === baseUom) return 1
  const multiplier = rules[uom]
  return typeof multiplier === 'number' && multiplier > 0 ? multiplier : null
}

/**
 * Convert an order quantity in the selected UOM to the equivalent base-unit quantity using
 * the material's conversion rules. Returns `null` when the UOM is not resolvable, letting the
 * caller surface a validation error instead of adding a mis-converted line.
 */
export function toBaseQty(
  qty: number,
  uom: string,
  baseUom: string,
  rules: UOMConversionRules
): number | null {
  const multiplier = resolveUomMultiplier(uom, baseUom, rules)
  return multiplier === null ? null : qty * multiplier
}

/** Validate the order quantity: required, integer, strictly positive. */
function validateQty(value: number | null): string | undefined {
  if (value === null) return 'Jumlah wajib diisi.'
  if (!Number.isInteger(value)) return 'Jumlah harus berupa bilangan bulat.'
  if (value <= 0) return 'Jumlah harus lebih dari nol.'
  return undefined
}

/** Validate the optional discount amount: when present, a non-negative number. */
function validateDiscount(value: number | null): string | undefined {
  if (value === null) return undefined
  if (value < 0) return 'Diskon tidak boleh negatif.'
  return undefined
}

/**
 * Validate the add-to-cart form. Returns a map of per-field messages; an empty map indicates
 * the line may be added. Enforces material, positive-integer qty, a chosen UOM, and a
 * non-negative optional discount — mirroring the backend `CreateOrderItemBody` rules that a
 * SALESMAN order is later validated against.
 */
export function validateOrderCartForm(state: OrderCartFormState): OrderCartFormErrors {
  const errors: OrderCartFormErrors = {}
  if (!state.materialId) errors.materialId = 'Material wajib dipilih.'
  const qty = validateQty(state.qty)
  if (qty) errors.qty = qty
  if (state.uom.trim().length === 0) errors.uom = 'Satuan (UOM) wajib dipilih.'
  const discount = validateDiscount(state.discountAmount)
  if (discount) errors.discountAmount = discount
  return errors
}

/** Whether the add-to-cart form currently passes validation. */
export function isOrderCartFormValid(state: OrderCartFormState): boolean {
  return Object.keys(validateOrderCartForm(state)).length === 0
}

/**
 * Build the {@link CartItemInput} passed to `useCartStore.addItem` from a validated form
 * state, the chosen material's identity/conversion rules, and the resolved per-base-UOM
 * price. Performs the UOM → base-qty conversion; returns `null` when the UOM is unresolvable
 * so the caller never enqueues a mis-converted line. Money totals are intentionally left to
 * the store (`base_qty × price_per_base_uom`), keeping this helper conversion-only.
 */
export function buildCartItemInput(
  state: OrderCartFormState,
  material: { id: string, name: string, base_uom: string, uom_conversion_rules: UOMConversionRules },
  pricePerBaseUom: number
): CartItemInput | null {
  const qty = state.qty ?? 0
  const baseQty = toBaseQty(qty, state.uom, material.base_uom, material.uom_conversion_rules)
  if (baseQty === null) return null
  return {
    material_id: material.id,
    material_name: material.name,
    qty,
    uom: state.uom,
    base_qty: baseQty,
    price_per_base_uom: pricePerBaseUom,
    discount_amount: state.discountAmount ?? 0
  }
}
