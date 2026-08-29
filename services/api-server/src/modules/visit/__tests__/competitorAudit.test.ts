import { describe, it, expect, mock, beforeEach } from 'bun:test'

import { FIELD_FORCE } from '../../../middleware/roleGuard'

// --- Mock transaction state (configurable per test) ---
interface MockTxState {
  ownedVisitRows: Array<Record<string, unknown>>
  insertRows: Array<Record<string, unknown>>
  updateRows: Array<Record<string, unknown>>
  deleteRows: Array<Record<string, unknown>>
  listRows: Array<Record<string, unknown>>
}

let txState: MockTxState

function resetTxState(): void {
  txState = {
    ownedVisitRows: [{ id: 'visit-1', companyId: 'company-1', userId: 'user-1' }],
    insertRows: [],
    updateRows: [],
    deleteRows: [],
    listRows: [],
  }
}

resetTxState()

/**
 * Builds a mock Drizzle transaction. The first `.select()` chain in every
 * competitor audit function is `fetchOwnedVisit` (resolved via `.limit()`);
 * subsequent `.select()` chains (list) resolve via `.orderBy()`.
 */
function buildMockTx() {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(txState.ownedVisitRows),
    orderBy: () => Promise.resolve(txState.listRows),
  }
  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve(txState.insertRows),
  }
  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(txState.updateRows),
  }
  const deleteChain = {
    where: () => deleteChain,
    returning: () => Promise.resolve(txState.deleteRows),
  }
  return {
    select: () => selectChain,
    insert: () => insertChain,
    update: () => updateChain,
    delete: () => deleteChain,
  }
}

mock.module('../../../db', () => ({
  withRLS: (_ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(buildMockTx()),
  resolveGeofenceTarget: () => Promise.resolve({ latitude: 0, longitude: 0 }),
}))

const {
  createCompetitorAudit,
  updateCompetitorAudit,
  deleteCompetitorAudit,
  listCompetitorAudits,
  ServiceError,
} = await import('../service')

const salesmanCtx = {
  companyId: 'company-1',
  userId: 'user-1',
  sofficeId: 'soffice-1',
  userRole: 'SALESMAN',
}

const mrCtx = {
  companyId: 'company-1',
  userId: 'user-1',
  sofficeId: 'soffice-1',
  userRole: 'MR',
}

const competitorRow = {
  id: 'comp-1',
  visitId: 'visit-1',
  competitorBrand: 'Acme Pharma',
  competitorProduct: 'PainAway 500mg',
  priceToPharmacy: '12500.00',
  consumerPrice: '15000.00',
  activePromoNotes: 'Buy 10 get 1 free',
  photoS3Key: 'company-1/photos/2025/comp-1.jpg',
  createdAt: '2025-01-01T00:00:00.000Z',
}

describe('visit/service — competitor audit CRUD', () => {
  beforeEach(() => {
    resetTxState()
  })

  describe('role access (FR-VST-04)', () => {
    it('should permit MR — competitor audit is accessible to both SALESMAN and MR', () => {
      expect(FIELD_FORCE).toContain('MR')
      expect(FIELD_FORCE).toContain('SALESMAN')
    })

    it('should perform createCompetitorAudit for an MR user (not gated to SALESMAN)', async () => {
      txState.insertRows = [competitorRow]

      const result = await createCompetitorAudit(
        'visit-1',
        { competitor_brand: 'Acme Pharma', competitor_product: 'PainAway 500mg' },
        mrCtx
      )

      expect(result.id).toBe('comp-1')
      expect(result.competitor_brand).toBe('Acme Pharma')
    })
  })

  describe('createCompetitorAudit', () => {
    it('should create a competitor audit and map it to the response shape', async () => {
      txState.insertRows = [competitorRow]

      const result = await createCompetitorAudit(
        'visit-1',
        {
          competitor_brand: 'Acme Pharma',
          competitor_product: 'PainAway 500mg',
          price_to_pharmacy: 12500,
          consumer_price: 15000,
          active_promo_notes: 'Buy 10 get 1 free',
          photo_s3_key: 'company-1/photos/2025/comp-1.jpg',
        },
        salesmanCtx
      )

      expect(result).toEqual({
        id: 'comp-1',
        visit_id: 'visit-1',
        competitor_brand: 'Acme Pharma',
        competitor_product: 'PainAway 500mg',
        price_to_pharmacy: 12500,
        consumer_price: 15000,
        active_promo_notes: 'Buy 10 get 1 free',
        photo_s3_key: 'company-1/photos/2025/comp-1.jpg',
        created_at: '2025-01-01T00:00:00.000Z',
      })
    })

    it('should default optional numeric fields to null when omitted', async () => {
      txState.insertRows = [
        {
          ...competitorRow,
          priceToPharmacy: null,
          consumerPrice: null,
          activePromoNotes: null,
          photoS3Key: null,
        },
      ]

      const result = await createCompetitorAudit(
        'visit-1',
        { competitor_brand: 'Beta Labs', competitor_product: 'ColdRelief' },
        salesmanCtx
      )

      expect(result.price_to_pharmacy).toBeNull()
      expect(result.consumer_price).toBeNull()
      expect(result.active_promo_notes).toBeNull()
      expect(result.photo_s3_key).toBeNull()
    })

    it('should throw VISIT_NOT_FOUND (404) when the visit does not exist', async () => {
      txState.ownedVisitRows = []

      await expect(
        createCompetitorAudit(
          'missing-visit',
          { competitor_brand: 'X', competitor_product: 'Y' },
          salesmanCtx
        )
      ).rejects.toMatchObject({ code: 'VISIT_NOT_FOUND', status: 404 })
    })

    it('should throw VISIT_NOT_OWNED (403) when the visit belongs to another user', async () => {
      txState.ownedVisitRows = [{ id: 'visit-1', companyId: 'company-1', userId: 'other-user' }]

      await expect(
        createCompetitorAudit(
          'visit-1',
          { competitor_brand: 'X', competitor_product: 'Y' },
          salesmanCtx
        )
      ).rejects.toMatchObject({ code: 'VISIT_NOT_OWNED', status: 403 })
    })
  })

  describe('updateCompetitorAudit', () => {
    it('should update partial fields and return the updated record', async () => {
      txState.updateRows = [{ ...competitorRow, consumerPrice: '17000.00' }]

      const result = await updateCompetitorAudit(
        'visit-1',
        'comp-1',
        { consumer_price: 17000 },
        salesmanCtx
      )

      expect(result.consumer_price).toBe(17000)
      expect(result.id).toBe('comp-1')
    })

    it('should set a nullable numeric field back to null', async () => {
      txState.updateRows = [{ ...competitorRow, priceToPharmacy: null }]

      const result = await updateCompetitorAudit(
        'visit-1',
        'comp-1',
        { price_to_pharmacy: null },
        salesmanCtx
      )

      expect(result.price_to_pharmacy).toBeNull()
    })

    it('should throw COMPETITOR_AUDIT_NOT_FOUND (404) when no matching row is updated', async () => {
      txState.updateRows = []

      await expect(
        updateCompetitorAudit('visit-1', 'missing', { competitor_brand: 'Z' }, salesmanCtx)
      ).rejects.toMatchObject({ code: 'COMPETITOR_AUDIT_NOT_FOUND', status: 404 })
    })

    it('should enforce ownership before updating', async () => {
      txState.ownedVisitRows = []

      await expect(
        updateCompetitorAudit('visit-1', 'comp-1', { competitor_brand: 'Z' }, salesmanCtx)
      ).rejects.toMatchObject({ code: 'VISIT_NOT_FOUND', status: 404 })
    })
  })

  describe('deleteCompetitorAudit', () => {
    it('should delete a competitor audit when it exists', async () => {
      txState.deleteRows = [{ id: 'comp-1' }]

      await expect(deleteCompetitorAudit('visit-1', 'comp-1', salesmanCtx)).resolves.toBeUndefined()
    })

    it('should throw COMPETITOR_AUDIT_NOT_FOUND (404) when nothing is deleted', async () => {
      txState.deleteRows = []

      await expect(
        deleteCompetitorAudit('visit-1', 'missing', salesmanCtx)
      ).rejects.toMatchObject({ code: 'COMPETITOR_AUDIT_NOT_FOUND', status: 404 })
    })
  })

  describe('listCompetitorAudits', () => {
    it('should return all competitor audits mapped to response shape', async () => {
      txState.listRows = [
        competitorRow,
        { ...competitorRow, id: 'comp-2', competitorBrand: 'Beta Labs' },
      ]

      const result = await listCompetitorAudits('visit-1', salesmanCtx)

      expect(result).toHaveLength(2)
      expect(result[0]?.id).toBe('comp-1')
      expect(result[1]?.id).toBe('comp-2')
      expect(result[1]?.competitor_brand).toBe('Beta Labs')
    })

    it('should return an empty array when there are no competitor audits', async () => {
      txState.listRows = []

      const result = await listCompetitorAudits('visit-1', salesmanCtx)

      expect(result).toEqual([])
    })

    it('should enforce ownership before listing', async () => {
      txState.ownedVisitRows = [{ id: 'visit-1', companyId: 'company-1', userId: 'other-user' }]

      await expect(listCompetitorAudits('visit-1', salesmanCtx)).rejects.toBeInstanceOf(ServiceError)
    })
  })
})
