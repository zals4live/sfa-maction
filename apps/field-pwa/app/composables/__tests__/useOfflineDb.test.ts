// `fake-indexeddb/auto` installs a global IndexedDB implementation so Dexie can run
// under Node. It MUST be imported before the composable (which imports the Dexie
// singleton `db`) so the store is backed by the fake engine.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BusinessLine,
  CustomerType,
  SyncStatus,
  UserRole,
  type LocalOutboxMutation,
  type MasterCustomer,
  type MasterMaterial,
  type VisitPlan
} from '@maction/types'
import type { UserLiniAssignment } from '~~/database'
import { db } from '~~/database'
import { useOfflineDb } from '../useOfflineDb'

const COMPANY_A = 'company-a'
const COMPANY_B = 'company-b'
const USER_1 = 'user-1'

function makeCustomer(id: string, companyId: string, type: CustomerType): MasterCustomer {
  return {
    id,
    company_id: companyId,
    soffice_id: 'soffice-1',
    customer_type: type,
    code: `C-${id}`,
    name: `Customer ${id}`,
    address: null,
    city: null,
    province: null,
    phone: null,
    email: null,
    location_geom: null,
    erp_customer_code: null,
    credit_limit: null,
    credit_used: null,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  }
}

function makeMaterial(id: string, companyId: string, line: BusinessLine): MasterMaterial {
  return {
    id,
    company_id: companyId,
    code: `M-${id}`,
    name: `Material ${id}`,
    description: null,
    business_line: line,
    base_uom: 'PCS',
    uom_conversion_rules: { PCS: 1 },
    erp_material_code: null,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  }
}

function makeVisitPlan(id: string, companyId: string, userId: string, planDate: string): VisitPlan {
  return {
    id,
    company_id: companyId,
    user_id: userId,
    customer_id: 'cust-1',
    outlet_context_id: null,
    plan_date: planDate,
    notes: null,
    is_completed: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  }
}

function makeLini(id: string, companyId: string, userId: string): UserLiniAssignment {
  return {
    id,
    company_id: companyId,
    user_id: userId,
    lini_id: `lini-${id}`,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  }
}

function makeMutation(id: string, capturedAt: string): LocalOutboxMutation {
  return {
    id,
    company_id: COMPANY_A,
    user_id: USER_1,
    user_role: UserRole.SALESMAN,
    mutation_type: 'ORDER_SUBMIT',
    endpoint: '/orders',
    http_method: 'POST',
    payload: {},
    sync_status: SyncStatus.PENDING,
    captured_at: capturedAt,
    mono_delta_ms: 0,
    synced_at: null,
    error_message: null,
    retry_count: 0
  }
}

describe('useOfflineDb', () => {
  const offline = useOfflineDb()

  beforeEach(async () => {
    await db.open()
  })

  afterEach(async () => {
    await Promise.all(db.tables.map(table => table.clear()))
  })

  it('should bulk upsert and read a customer by compound key', async () => {
    await offline.bulkPutCustomers([makeCustomer('1', COMPANY_A, CustomerType.OUTLET)])
    const found = await offline.getCustomer(COMPANY_A, '1')
    expect(found?.name).toBe('Customer 1')
  })

  it('should isolate reads by company_id (tenant isolation)', async () => {
    await offline.bulkPutCustomers([
      makeCustomer('1', COMPANY_A, CustomerType.OUTLET),
      makeCustomer('1', COMPANY_B, CustomerType.OUTLET)
    ])
    const companyA = await offline.listCustomersByCompany(COMPANY_A)
    expect(companyA).toHaveLength(1)
    expect(companyA[0]?.company_id).toBe(COMPANY_A)
  })

  it('should filter customers by company + customer_type', async () => {
    await offline.bulkPutCustomers([
      makeCustomer('1', COMPANY_A, CustomerType.OUTLET),
      makeCustomer('2', COMPANY_A, CustomerType.PERSON)
    ])
    const outlets = await offline.listCustomersByType(COMPANY_A, CustomerType.OUTLET)
    expect(outlets).toHaveLength(1)
    expect(outlets[0]?.customer_type).toBe(CustomerType.OUTLET)
  })

  it('should filter materials by company + business_line', async () => {
    await offline.bulkPutMaterials([
      makeMaterial('1', COMPANY_A, BusinessLine.PHARMA),
      makeMaterial('2', COMPANY_A, BusinessLine.ALKES)
    ])
    const pharma = await offline.listMaterialsByBusinessLine(COMPANY_A, BusinessLine.PHARMA)
    expect(pharma).toHaveLength(1)
    expect(pharma[0]?.business_line).toBe(BusinessLine.PHARMA)
  })

  it('should query visit plans by user and by user+date', async () => {
    await offline.bulkPutVisitPlans([
      makeVisitPlan('1', COMPANY_A, USER_1, '2024-05-01'),
      makeVisitPlan('2', COMPANY_A, USER_1, '2024-05-02')
    ])
    expect(await offline.listVisitPlansByUser(COMPANY_A, USER_1)).toHaveLength(2)
    const today = await offline.listVisitPlansByUserAndDate(COMPANY_A, USER_1, '2024-05-01')
    expect(today).toHaveLength(1)
    expect(today[0]?.id).toBe('1')
  })

  it('should list lini assignments by user', async () => {
    await offline.bulkPutUserLiniAssignments([
      makeLini('1', COMPANY_A, USER_1),
      makeLini('2', COMPANY_A, 'user-2')
    ])
    const assignments = await offline.listLiniAssignmentsByUser(COMPANY_A, USER_1)
    expect(assignments).toHaveLength(1)
    expect(assignments[0]?.user_id).toBe(USER_1)
  })

  it('should clear only the target company data on re-sync', async () => {
    await offline.bulkPutCustomers([
      makeCustomer('1', COMPANY_A, CustomerType.OUTLET),
      makeCustomer('1', COMPANY_B, CustomerType.OUTLET)
    ])
    await offline.bulkPutMaterials([makeMaterial('1', COMPANY_A, BusinessLine.PHARMA)])
    await offline.clearCompanyData(COMPANY_A)
    expect(await offline.listCustomersByCompany(COMPANY_A)).toHaveLength(0)
    expect(await offline.listMaterialsByBusinessLine(COMPANY_A, BusinessLine.PHARMA)).toHaveLength(0)
    expect(await offline.listCustomersByCompany(COMPANY_B)).toHaveLength(1)
  })

  it('should drain pending mutations in FIFO (captured_at) order', async () => {
    await offline.enqueueMutation(makeMutation('m2', '2024-05-01T10:00:00Z'))
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.enqueueMutation(makeMutation('m3', '2024-05-01T11:00:00Z'))
    const pending = await offline.listPendingMutations()
    expect(pending.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('should respect the limit when listing pending mutations', async () => {
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.enqueueMutation(makeMutation('m2', '2024-05-01T10:00:00Z'))
    const pending = await offline.listPendingMutations(1)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe('m1')
  })

  it('should exclude non-pending mutations from the pending list', async () => {
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.updateMutationStatus('m1', {
      sync_status: SyncStatus.SYNCED,
      synced_at: '2024-05-01T09:05:00Z'
    })
    expect(await offline.listPendingMutations()).toHaveLength(0)
  })

  it('should delete a synced mutation', async () => {
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.deleteMutation('m1')
    expect(await db.outbox_mutations.get('m1')).toBeUndefined()
  })

  it('should include both PENDING and FAILED mutations in the retryable list, in FIFO order', async () => {
    // A FAILED mutation must remain retryable so a background-sync retry re-attempts it
    // instead of abandoning it (see useBackgroundSync retry path).
    await offline.enqueueMutation(makeMutation('m2', '2024-05-01T10:00:00Z'))
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.updateMutationStatus('m1', {
      sync_status: SyncStatus.FAILED,
      error_message: 'server 500',
      retry_count: 1
    })
    const retryable = await offline.listRetryableMutations()
    expect(retryable.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('should exclude SYNCED mutations from the retryable list', async () => {
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.updateMutationStatus('m1', {
      sync_status: SyncStatus.SYNCED,
      synced_at: '2024-05-01T09:05:00Z'
    })
    expect(await offline.listRetryableMutations()).toHaveLength(0)
  })

  it('should respect the limit when listing retryable mutations', async () => {
    await offline.enqueueMutation(makeMutation('m1', '2024-05-01T09:00:00Z'))
    await offline.enqueueMutation(makeMutation('m2', '2024-05-01T10:00:00Z'))
    const retryable = await offline.listRetryableMutations(1)
    expect(retryable).toHaveLength(1)
    expect(retryable[0]?.id).toBe('m1')
  })
})
