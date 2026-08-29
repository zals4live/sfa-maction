import { describe, it, expect } from 'bun:test'

import {
  resolveDiscountPercentage,
  generateOrderNumber,
  ServiceError,
  type ActivePromotion,
} from '../service'

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

describe('order/service', () => {
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

  describe('generateOrderNumber', () => {
    it('formats the first number of a tenant/date as ORD-YYYYMMDD-0001', async () => {
      const tx = createSequenceTx()
      const result = await generateOrderNumber(tx as never, 'company-1', '2024-12-31')
      expect(result).toBe('ORD-20241231-0001')
    })

    it('increments the sequence within the same tenant and date', async () => {
      const tx = createSequenceTx()
      const first = await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      const second = await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      const third = await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      expect([first, second, third]).toEqual([
        'ORD-20240309-0001',
        'ORD-20240309-0002',
        'ORD-20240309-0003',
      ])
    })

    it('isolates sequences across tenants for the same date', async () => {
      const tx = createSequenceTx()
      await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      const otherTenant = await generateOrderNumber(tx as never, 'company-2', '2024-03-09')
      expect(otherTenant).toBe('ORD-20240309-0001')
    })

    it('resets the sequence when the date changes for a tenant', async () => {
      const tx = createSequenceTx()
      await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      await generateOrderNumber(tx as never, 'company-1', '2024-03-09')
      const nextDay = await generateOrderNumber(tx as never, 'company-1', '2024-03-10')
      expect(nextDay).toBe('ORD-20240310-0001')
    })

    it('produces unique numbers under concurrent generation for one tenant/date', async () => {
      const tx = createSequenceTx()
      const results = await Promise.all(
        Array.from({ length: 50 }, () => generateOrderNumber(tx as never, 'company-1', '2024-03-09'))
      )
      expect(new Set(results).size).toBe(50)
    })
  })

  describe('ServiceError', () => {
    it('captures a code, message, and status', () => {
      const err = new ServiceError('PRICE_NOT_FOUND', 'No price', 422)
      expect(err.code).toBe('PRICE_NOT_FOUND')
      expect(err.status).toBe(422)
      expect(err).toBeInstanceOf(Error)
    })
  })
})

/**
 * Stateful mock transaction modeling the atomic `order_sequences` upsert used by
 * generateOrderNumber. It keeps an in-memory counter per (companyId, orderDate)
 * and increments it synchronously when `.returning()` is awaited, mirroring the
 * gap-free, per-tenant/per-date behavior of the real INSERT ... ON CONFLICT.
 */
function createSequenceTx() {
  const counters = new Map<string, number>()

  return {
    insert: () => ({
      values: (row: { companyId: string; orderDate: string }) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            const key = `${row.companyId}|${row.orderDate}`
            const next = (counters.get(key) ?? 0) + 1
            counters.set(key, next)
            return Promise.resolve([{ lastSequence: next }])
          },
        }),
      }),
    }),
  }
}
