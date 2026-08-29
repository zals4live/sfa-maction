import { describe, it, expect, mock, beforeEach } from 'bun:test'

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
 * Builds a mock Drizzle transaction. The first `.select()` chain in every stock
 * audit function is `fetchOwnedVisit` (resolved via `.limit()`); subsequent
 * `.select()` chains (list) resolve via `.orderBy()`.
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
  createStockAudit,
  updateStockAudit,
  deleteStockAudit,
  listStockAudits,
  ServiceError,
} = await import('../service')

const ctx = {
  companyId: 'company-1',
  userId: 'user-1',
  sofficeId: 'soffice-1',
  userRole: 'SALESMAN',
}

const stockRow = {
  id: 'audit-1',
  visitId: 'visit-1',
  materialId: 'material-1',
  physicalStockQty: 42,
  uom: 'BOX',
  estimatedDaysOfStock: 7,
  createdAt: '2025-01-01T00:00:00.000Z',
}

describe('visit/service — stock audit CRUD', () => {
  beforeEach(() => {
    resetTxState()
  })

  describe('createStockAudit', () => {
    it('should create a stock audit and map it to the response shape', async () => {
      txState.insertRows = [stockRow]

      const result = await createStockAudit(
        'visit-1',
        { material_id: 'material-1', physical_stock_qty: 42, uom: 'BOX', estimated_days_of_stock: 7 },
        ctx
      )

      expect(result).toEqual({
        id: 'audit-1',
        visit_id: 'visit-1',
        material_id: 'material-1',
        physical_stock_qty: 42,
        uom: 'BOX',
        estimated_days_of_stock: 7,
        created_at: '2025-01-01T00:00:00.000Z',
      })
    })

    it('should default estimated_days_of_stock to null when omitted', async () => {
      txState.insertRows = [{ ...stockRow, estimatedDaysOfStock: null }]

      const result = await createStockAudit(
        'visit-1',
        { material_id: 'material-1', physical_stock_qty: 10, uom: 'PCS' },
        ctx
      )

      expect(result.estimated_days_of_stock).toBeNull()
    })

    it('should throw VISIT_NOT_FOUND (404) when the visit does not exist', async () => {
      txState.ownedVisitRows = []

      await expect(
        createStockAudit('missing-visit', { material_id: 'm', physical_stock_qty: 1, uom: 'PCS' }, ctx)
      ).rejects.toMatchObject({ code: 'VISIT_NOT_FOUND', status: 404 })
    })

    it('should throw VISIT_NOT_OWNED (403) when the visit belongs to another user', async () => {
      txState.ownedVisitRows = [{ id: 'visit-1', companyId: 'company-1', userId: 'other-user' }]

      await expect(
        createStockAudit('visit-1', { material_id: 'm', physical_stock_qty: 1, uom: 'PCS' }, ctx)
      ).rejects.toMatchObject({ code: 'VISIT_NOT_OWNED', status: 403 })
    })
  })

  describe('updateStockAudit', () => {
    it('should update partial fields and return the updated record', async () => {
      txState.updateRows = [{ ...stockRow, physicalStockQty: 99 }]

      const result = await updateStockAudit('visit-1', 'audit-1', { physical_stock_qty: 99 }, ctx)

      expect(result.physical_stock_qty).toBe(99)
      expect(result.id).toBe('audit-1')
    })

    it('should throw STOCK_AUDIT_NOT_FOUND (404) when no matching row is updated', async () => {
      txState.updateRows = []

      await expect(
        updateStockAudit('visit-1', 'missing-audit', { uom: 'STRIP' }, ctx)
      ).rejects.toMatchObject({ code: 'STOCK_AUDIT_NOT_FOUND', status: 404 })
    })

    it('should enforce ownership before updating', async () => {
      txState.ownedVisitRows = []

      await expect(
        updateStockAudit('visit-1', 'audit-1', { uom: 'STRIP' }, ctx)
      ).rejects.toMatchObject({ code: 'VISIT_NOT_FOUND', status: 404 })
    })
  })

  describe('deleteStockAudit', () => {
    it('should delete a stock audit when it exists', async () => {
      txState.deleteRows = [{ id: 'audit-1' }]

      await expect(deleteStockAudit('visit-1', 'audit-1', ctx)).resolves.toBeUndefined()
    })

    it('should throw STOCK_AUDIT_NOT_FOUND (404) when nothing is deleted', async () => {
      txState.deleteRows = []

      await expect(
        deleteStockAudit('visit-1', 'missing-audit', ctx)
      ).rejects.toMatchObject({ code: 'STOCK_AUDIT_NOT_FOUND', status: 404 })
    })
  })

  describe('listStockAudits', () => {
    it('should return all stock audits mapped to response shape', async () => {
      txState.listRows = [stockRow, { ...stockRow, id: 'audit-2', physicalStockQty: 5 }]

      const result = await listStockAudits('visit-1', ctx)

      expect(result).toHaveLength(2)
      expect(result[0]?.id).toBe('audit-1')
      expect(result[1]?.id).toBe('audit-2')
      expect(result[1]?.physical_stock_qty).toBe(5)
    })

    it('should return an empty array when there are no stock audits', async () => {
      txState.listRows = []

      const result = await listStockAudits('visit-1', ctx)

      expect(result).toEqual([])
    })

    it('should enforce ownership before listing', async () => {
      txState.ownedVisitRows = [{ id: 'visit-1', companyId: 'company-1', userId: 'other-user' }]

      await expect(listStockAudits('visit-1', ctx)).rejects.toBeInstanceOf(ServiceError)
    })
  })
})
