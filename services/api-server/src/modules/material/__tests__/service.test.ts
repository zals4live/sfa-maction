import { describe, it, expect } from 'bun:test'

import {
  resolveAsOfDate,
  buildPriceConditions,
  getMaterialPrice,
  ServiceError,
} from '../service'
import type { MaterialPriceParams } from '../schemas'

describe('material/service — regional price lookup', () => {
  describe('resolveAsOfDate', () => {
    it('returns the supplied as-of date verbatim', () => {
      expect(resolveAsOfDate('2024-03-09')).toBe('2024-03-09')
    })

    it("defaults to today's UTC date (YYYY-MM-DD) when omitted", () => {
      const expected = new Date().toISOString().slice(0, 10)
      expect(resolveAsOfDate()).toBe(expected)
      expect(resolveAsOfDate(undefined)).toBe(expected)
    })
  })

  describe('buildPriceConditions', () => {
    const materialId = '11111111-1111-1111-1111-111111111111'

    it('always includes material + validity-window conditions', () => {
      const conditions = buildPriceConditions(materialId, {}, '2024-03-09')
      // material + validFrom<=asOf + validTo>=asOf + varian(IS NULL) = 4
      expect(conditions).toHaveLength(4)
    })

    it('adds a soffice condition when soffice_id is provided', () => {
      const params: MaterialPriceParams = { soffice_id: '22222222-2222-2222-2222-222222222222' }
      const conditions = buildPriceConditions(materialId, params, '2024-03-09')
      // material + validFrom + validTo + soffice + varian(IS NULL) = 5
      expect(conditions).toHaveLength(5)
    })

    it('matches an explicit variant when varian_id is provided', () => {
      const params: MaterialPriceParams = { varian_id: '33333333-3333-3333-3333-333333333333' }
      const conditions = buildPriceConditions(materialId, params, '2024-03-09')
      expect(conditions).toHaveLength(4)
    })

    it('scopes to soffice + variant together for a full regional lookup', () => {
      const params: MaterialPriceParams = {
        soffice_id: '22222222-2222-2222-2222-222222222222',
        varian_id: '33333333-3333-3333-3333-333333333333',
      }
      const conditions = buildPriceConditions(materialId, params, '2024-03-09')
      expect(conditions).toHaveLength(5)
    })
  })

  describe('getMaterialPrice', () => {
    const materialId = '11111111-1111-1111-1111-111111111111'

    it('returns the mapped price record when a valid regional price exists', async () => {
      const priceRow = {
        id: 'price-1',
        companyId: 'company-1',
        sofficeId: 'soffice-1',
        materialId,
        varianId: null,
        priceRegular: '15000.00',
        priceHja: '18000.00',
        priceHet: null,
        per: 10,
        salesUom: 'BOX',
        validFrom: '2024-01-01',
        validTo: '2024-12-31',
        createdAt: '2024-01-01T00:00:00.000Z',
      }
      const tx = createPriceTx({ materialExists: true, priceRow })

      const result = await getMaterialPrice(tx as never, materialId, { as_of: '2024-03-09' })

      expect(result.id).toBe('price-1')
      expect(result.price_regular).toBe(15000)
      expect(result.price_hja).toBe(18000)
      expect(result.price_het).toBeNull()
      expect(result.per).toBe(10)
      expect(result.varian_id).toBeNull()
    })

    it('throws MATERIAL_NOT_FOUND (404) when the material does not exist', async () => {
      const tx = createPriceTx({ materialExists: false, priceRow: null })

      const promise = getMaterialPrice(tx as never, materialId, {})
      await expect(promise).rejects.toBeInstanceOf(ServiceError)
      await expect(promise).rejects.toMatchObject({ code: 'MATERIAL_NOT_FOUND', status: 404 })
    })

    it('throws PRICE_NOT_FOUND (404) when no price covers the query date', async () => {
      const tx = createPriceTx({ materialExists: true, priceRow: null })

      const promise = getMaterialPrice(tx as never, materialId, { as_of: '2024-03-09' })
      await expect(promise).rejects.toBeInstanceOf(ServiceError)
      await expect(promise).rejects.toMatchObject({ code: 'PRICE_NOT_FOUND', status: 404 })
    })
  })
})

/**
 * Minimal mock transaction. The material-existence check runs first
 * (select().from().where() → array), then the price lookup adds
 * .orderBy().limit() before resolving. We branch on whether limit() is present:
 * the first (existence) query resolves at where(); the second (price) query
 * resolves at limit().
 */
function createPriceTx(opts: { materialExists: boolean; priceRow: unknown | null }) {
  let call = 0
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.from = () => chain
    chain.where = () => {
      // First call = assertMaterialExists (resolves at where()).
      // Subsequent calls continue the chain for the price query.
      if (call === 0) {
        call++
        return Promise.resolve(opts.materialExists ? [{ id: 'material-1' }] : [])
      }
      return chain
    }
    chain.orderBy = () => chain
    chain.limit = () => Promise.resolve(opts.priceRow ? [opts.priceRow] : [])
    return chain
  }
  return makeChain()
}
