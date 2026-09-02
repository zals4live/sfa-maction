/**
 * `useOfflineDb` — type-safe CRUD wrappers over the Field PWA Dexie.js database.
 *
 * All DB access is deferred into the returned functions so this composable never
 * touches IndexedDB at module top-level (Dexie is browser-only and must not run
 * during SSR). Tenant-scoped tables use the `[company_id+id]` compound primary key,
 * so every read/clear helper is scoped by `company_id` to preserve tenant isolation.
 */
import Dexie from 'dexie'
import type {
  MasterCustomer,
  DoctorProfile,
  DoctorOutletAssignment,
  MasterMaterial,
  VisitPlan,
  LocalOutboxMutation,
  CustomerType,
  BusinessLine
} from '@maction/types'
import { SyncStatus } from '@maction/types'
import { db, type UserLiniAssignment } from '~~/database'

/** Public surface returned by {@link useOfflineDb}. */
export interface OfflineDbApi {
  bulkPutCustomers: (rows: MasterCustomer[]) => Promise<void>
  bulkPutDoctorProfiles: (rows: DoctorProfile[]) => Promise<void>
  bulkPutDoctorOutletAssignments: (rows: DoctorOutletAssignment[]) => Promise<void>
  bulkPutUserLiniAssignments: (rows: UserLiniAssignment[]) => Promise<void>
  bulkPutMaterials: (rows: MasterMaterial[]) => Promise<void>
  bulkPutVisitPlans: (rows: VisitPlan[]) => Promise<void>
  getCustomer: (companyId: string, id: string) => Promise<MasterCustomer | undefined>
  getMaterial: (companyId: string, id: string) => Promise<MasterMaterial | undefined>
  listCustomersByCompany: (companyId: string) => Promise<MasterCustomer[]>
  listCustomersByType: (companyId: string, customerType: CustomerType) => Promise<MasterCustomer[]>
  listMaterialsByBusinessLine: (companyId: string, businessLine: BusinessLine) => Promise<MasterMaterial[]>
  listVisitPlansByUser: (companyId: string, userId: string) => Promise<VisitPlan[]>
  listVisitPlansByUserAndDate: (companyId: string, userId: string, planDate: string) => Promise<VisitPlan[]>
  listLiniAssignmentsByUser: (companyId: string, userId: string) => Promise<UserLiniAssignment[]>
  clearCompanyData: (companyId: string) => Promise<void>
  enqueueMutation: (mutation: LocalOutboxMutation) => Promise<string>
  listPendingMutations: (limit?: number) => Promise<LocalOutboxMutation[]>
  updateMutationStatus: (id: string, changes: Partial<LocalOutboxMutation>) => Promise<number>
  deleteMutation: (id: string) => Promise<void>
}

/**
 * Access the offline Dexie database through a stable set of CRUD helpers.
 * DB calls only execute when the returned functions are invoked (client-side).
 */
export function useOfflineDb(): OfflineDbApi {
  function bulkPutCustomers(rows: MasterCustomer[]): Promise<void> {
    return db.customers.bulkPut(rows).then(() => undefined)
  }

  function bulkPutDoctorProfiles(rows: DoctorProfile[]): Promise<void> {
    return db.doctor_profiles.bulkPut(rows).then(() => undefined)
  }

  function bulkPutDoctorOutletAssignments(rows: DoctorOutletAssignment[]): Promise<void> {
    return db.doctor_outlet_assignments.bulkPut(rows).then(() => undefined)
  }

  function bulkPutUserLiniAssignments(rows: UserLiniAssignment[]): Promise<void> {
    return db.user_lini_assignments.bulkPut(rows).then(() => undefined)
  }

  function bulkPutMaterials(rows: MasterMaterial[]): Promise<void> {
    return db.materials.bulkPut(rows).then(() => undefined)
  }

  function bulkPutVisitPlans(rows: VisitPlan[]): Promise<void> {
    return db.visit_plans.bulkPut(rows).then(() => undefined)
  }

  function getCustomer(companyId: string, id: string): Promise<MasterCustomer | undefined> {
    return db.customers.get([companyId, id])
  }

  function getMaterial(companyId: string, id: string): Promise<MasterMaterial | undefined> {
    return db.materials.get([companyId, id])
  }

  function listCustomersByCompany(companyId: string): Promise<MasterCustomer[]> {
    return db.customers.where('company_id').equals(companyId).toArray()
  }

  function listCustomersByType(companyId: string, customerType: CustomerType): Promise<MasterCustomer[]> {
    return db.customers.where('[company_id+customer_type]').equals([companyId, customerType]).toArray()
  }

  function listMaterialsByBusinessLine(companyId: string, businessLine: BusinessLine): Promise<MasterMaterial[]> {
    return db.materials.where('[company_id+business_line]').equals([companyId, businessLine]).toArray()
  }

  function listVisitPlansByUser(companyId: string, userId: string): Promise<VisitPlan[]> {
    return db.visit_plans.where('[company_id+user_id]').equals([companyId, userId]).toArray()
  }

  function listVisitPlansByUserAndDate(
    companyId: string,
    userId: string,
    planDate: string
  ): Promise<VisitPlan[]> {
    return db.visit_plans
      .where('[company_id+user_id+plan_date]')
      .equals([companyId, userId, planDate])
      .toArray()
  }

  function listLiniAssignmentsByUser(companyId: string, userId: string): Promise<UserLiniAssignment[]> {
    return db.user_lini_assignments.where('[company_id+user_id]').equals([companyId, userId]).toArray()
  }

  /** Purge every tenant-scoped table for a company — used on tenant switch / full re-sync. */
  async function clearCompanyData(companyId: string): Promise<void> {
    const tenantTables = [
      db.customers,
      db.doctor_profiles,
      db.doctor_outlet_assignments,
      db.user_lini_assignments,
      db.materials,
      db.visit_plans
    ]
    await Promise.all(tenantTables.map(table => table.where('company_id').equals(companyId).delete()))
  }

  function enqueueMutation(mutation: LocalOutboxMutation): Promise<string> {
    return db.outbox_mutations.put(mutation)
  }

  /** List outbox mutations awaiting sync in FIFO order via the `[sync_status+captured_at]` index. */
  function listPendingMutations(limit?: number): Promise<LocalOutboxMutation[]> {
    const query = db.outbox_mutations
      .where('[sync_status+captured_at]')
      .between([SyncStatus.PENDING, Dexie.minKey], [SyncStatus.PENDING, Dexie.maxKey])
    return (limit ? query.limit(limit) : query).toArray()
  }

  function updateMutationStatus(id: string, changes: Partial<LocalOutboxMutation>): Promise<number> {
    return db.outbox_mutations.update(id, changes)
  }

  function deleteMutation(id: string): Promise<void> {
    return db.outbox_mutations.delete(id)
  }

  return {
    bulkPutCustomers,
    bulkPutDoctorProfiles,
    bulkPutDoctorOutletAssignments,
    bulkPutUserLiniAssignments,
    bulkPutMaterials,
    bulkPutVisitPlans,
    getCustomer,
    getMaterial,
    listCustomersByCompany,
    listCustomersByType,
    listMaterialsByBusinessLine,
    listVisitPlansByUser,
    listVisitPlansByUserAndDate,
    listLiniAssignmentsByUser,
    clearCompanyData,
    enqueueMutation,
    listPendingMutations,
    updateMutationStatus,
    deleteMutation
  }
}
