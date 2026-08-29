import { describe, it, expect } from 'bun:test';

import {
  roundMoney,
  computeLinePricing,
  computeOrderTotals,
  computeTax,
} from '../pricing.js';

describe('pricing', () => {
  describe('roundMoney', () => {
    it('rounds to 2 decimal places', () => {
      expect(roundMoney(1.005)).toBe(1.01);
      expect(roundMoney(1234.567)).toBe(1234.57);
    });
  });

  describe('computeLinePricing', () => {
    it('computes gross, discount, and subtotal with a percentage discount', () => {
      const result = computeLinePricing({ qty: 10, unitPrice: 1000, discountPercentage: 10 });
      expect(result.grossAmount).toBe(10000);
      expect(result.discountAmount).toBe(1000);
      expect(result.subtotal).toBe(9000);
    });

    it('defaults discount to zero when omitted', () => {
      const result = computeLinePricing({ qty: 3, unitPrice: 2500 });
      expect(result.grossAmount).toBe(7500);
      expect(result.discountAmount).toBe(0);
      expect(result.subtotal).toBe(7500);
    });

    it('clamps out-of-range discount percentages', () => {
      const over = computeLinePricing({ qty: 1, unitPrice: 100, discountPercentage: 150 });
      expect(over.discountAmount).toBe(100);
      const under = computeLinePricing({ qty: 1, unitPrice: 100, discountPercentage: -20 });
      expect(under.discountAmount).toBe(0);
    });

    it('applies a flat fixed discount amount', () => {
      const result = computeLinePricing({ qty: 5, unitPrice: 1000, fixedDiscountAmount: 750 });
      expect(result.grossAmount).toBe(5000);
      expect(result.discountAmount).toBe(750);
      expect(result.subtotal).toBe(4250);
    });

    it('stacks percentage and fixed discounts', () => {
      const result = computeLinePricing({
        qty: 10,
        unitPrice: 1000,
        discountPercentage: 10,
        fixedDiscountAmount: 500,
      });
      expect(result.grossAmount).toBe(10000);
      expect(result.discountAmount).toBe(1500);
      expect(result.subtotal).toBe(8500);
    });

    it('caps the combined discount at the line gross so subtotal is never negative', () => {
      const result = computeLinePricing({
        qty: 2,
        unitPrice: 1000,
        discountPercentage: 50,
        fixedDiscountAmount: 5000,
      });
      expect(result.grossAmount).toBe(2000);
      expect(result.discountAmount).toBe(2000);
      expect(result.subtotal).toBe(0);
    });

    it('ignores non-positive fixed discounts', () => {
      const result = computeLinePricing({ qty: 1, unitPrice: 100, fixedDiscountAmount: -50 });
      expect(result.discountAmount).toBe(0);
      expect(result.subtotal).toBe(100);
    });
  });

  describe('computeTax', () => {
    it('applies PPN 11% to the taxable amount', () => {
      expect(computeTax(100000, 11)).toBe(11000);
    });

    it('treats negative rates as zero', () => {
      expect(computeTax(100000, -5)).toBe(0);
    });
  });

  describe('computeOrderTotals', () => {
    it('aggregates line subtotals and applies tax to the net subtotal', () => {
      const result = computeOrderTotals({
        lineSubtotals: [9000, 7500],
        lineDiscounts: [1000, 0],
        taxRate: 11,
      });
      expect(result.subtotalAmount).toBe(16500);
      expect(result.totalDiscountAmount).toBe(1000);
      expect(result.taxAmount).toBe(1815);
      expect(result.grandTotal).toBe(18315);
    });

    it('handles an empty order', () => {
      const result = computeOrderTotals({ lineSubtotals: [], lineDiscounts: [], taxRate: 11 });
      expect(result.subtotalAmount).toBe(0);
      expect(result.taxAmount).toBe(0);
      expect(result.grandTotal).toBe(0);
    });

    it('applies a custom tenant tax rate to the net subtotal', () => {
      const result = computeOrderTotals({
        lineSubtotals: [50000],
        lineDiscounts: [0],
        taxRate: 7.5,
      });
      expect(result.subtotalAmount).toBe(50000);
      expect(result.taxAmount).toBe(3750);
      expect(result.grandTotal).toBe(53750);
    });

    it('produces zero tax when the tenant tax rate is zero', () => {
      const result = computeOrderTotals({
        lineSubtotals: [12000, 8000],
        lineDiscounts: [0, 0],
        taxRate: 0,
      });
      expect(result.subtotalAmount).toBe(20000);
      expect(result.taxAmount).toBe(0);
      expect(result.grandTotal).toBe(20000);
    });

    it('taxes the net subtotal (post-discount), never the gross', () => {
      // Gross line = 10 * 1000 = 10000, 20% discount => net subtotal 8000.
      const line = computeLinePricing({ qty: 10, unitPrice: 1000, discountPercentage: 20 });
      const result = computeOrderTotals({
        lineSubtotals: [line.subtotal],
        lineDiscounts: [line.discountAmount],
        taxRate: 11,
      });
      expect(result.subtotalAmount).toBe(8000);
      expect(result.totalDiscountAmount).toBe(2000);
      // 11% of the NET 8000 = 880, not 11% of gross 10000 (=1100).
      expect(result.taxAmount).toBe(880);
      expect(result.grandTotal).toBe(8880);
    });
  });
});
