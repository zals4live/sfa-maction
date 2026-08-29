/**
 * Pricing, discount, and tax (PPN) calculation utilities for order taking.
 *
 * All monetary values are treated as decimal numbers (IDR). Callers are
 * responsible for persisting them at the appropriate precision (numeric(15,2)).
 * Every returned amount is rounded to 2 decimal places to avoid floating-point
 * drift accumulating across many line items.
 */

/** Rounds a monetary amount to 2 decimal places (bankers-free, half-up). */
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Inputs required to compute a single order line's monetary breakdown. */
export interface LinePricingInput {
  /** Quantity in the selected UOM. */
  qty: number;
  /** Price for one unit of the selected UOM. */
  unitPrice: number;
  /** Line-item discount percentage (0–100). */
  discountPercentage?: number;
  /**
   * Flat monetary discount applied to the whole line (e.g. a FIXED_AMOUNT
   * promotion). Applied after the percentage discount and capped so the line
   * subtotal never goes negative.
   */
  fixedDiscountAmount?: number;
}

/** Computed monetary breakdown for a single order line. */
export interface LinePricingResult {
  grossAmount: number;
  discountAmount: number;
  subtotal: number;
}

/**
 * Computes the gross, discount, and net subtotal for a single order line.
 * Percentage and flat (fixed-amount) discounts stack, but the combined discount
 * is capped at the line gross so `subtotal` never goes negative.
 * `subtotal = max(0, qty * unitPrice - discount)`.
 */
export function computeLinePricing(input: LinePricingInput): LinePricingResult {
  const grossAmount = roundMoney(input.qty * input.unitPrice);
  const pct = clampPercentage(input.discountPercentage ?? 0);
  const pctDiscount = grossAmount * (pct / 100);
  const fixed = input.fixedDiscountAmount && input.fixedDiscountAmount > 0 ? input.fixedDiscountAmount : 0;
  const discountAmount = roundMoney(Math.min(pctDiscount + fixed, grossAmount));
  const subtotal = roundMoney(grossAmount - discountAmount);
  return { grossAmount, discountAmount, subtotal };
}

/** Inputs for order-header total computation. */
export interface OrderTotalsInput {
  /** Net subtotal per line (already discount-adjusted). */
  lineSubtotals: number[];
  /** Per-line discount amounts. */
  lineDiscounts: number[];
  /** Tax rate percentage (e.g., 11 for PPN 11%). */
  taxRate: number;
}

/** Computed order-header monetary totals. */
export interface OrderTotalsResult {
  subtotalAmount: number;
  totalDiscountAmount: number;
  taxAmount: number;
  grandTotal: number;
}

/**
 * Aggregates line subtotals into order-header totals and applies PPN tax on the
 * net subtotal. `grandTotal = subtotal + tax`.
 */
export function computeOrderTotals(input: OrderTotalsInput): OrderTotalsResult {
  const subtotalAmount = roundMoney(sum(input.lineSubtotals));
  const totalDiscountAmount = roundMoney(sum(input.lineDiscounts));
  const taxAmount = computeTax(subtotalAmount, input.taxRate);
  const grandTotal = roundMoney(subtotalAmount + taxAmount);
  return { subtotalAmount, totalDiscountAmount, taxAmount, grandTotal };
}

/** Computes tax for a taxable base at the given percentage rate. */
export function computeTax(taxableAmount: number, taxRate: number): number {
  const rate = taxRate < 0 ? 0 : taxRate;
  return roundMoney(taxableAmount * (rate / 100));
}

/** Clamps a percentage into the valid 0–100 range. */
function clampPercentage(pct: number): number {
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
