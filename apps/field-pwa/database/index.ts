/**
 * Dexie.js (IndexedDB) offline database for the KF Maction Field PWA.
 *
 * Mirrors the tenant-scoped backend master data required for full offline
 * operation (check-in → visit → in-visit activities → visit-out → order/no-order)
 * plus a local outbox queue for background sync.
 *
 * Multi-tenancy: every table that mirrors tenant-scoped backend master data uses a
 * COMPOUND PRIMARY KEY `[company_id+id]` so records from different tenants never
 * collide in a shared IndexedDB store. The outbox uses a local `id` primary key and
 * is indexed by `sync_status` + `captured_at` for FIFO batch draining.
 */

import Dexie, { type Table } from 'dexie';
import type {
  MasterCustomer,
  DoctorProfile,
  DoctorOutletAssignment,
  MasterMaterial,
  VisitPlan,
  LocalOutboxMutation
} from '@maction/types';

/**
 * Represents the `user_lini_assignments` junction — scopes which business lines a
 * field user can access. Cached offline so the material catalog can be lini-filtered
 * without a network round-trip. Mirrors the backend M:N junction table.
 */
export interface UserLiniAssignment {
  id: string;
  company_id: string;
  user_id: string;
  lini_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Dexie database version. Bump this and add a new `.version()` block when the schema
 * changes so IndexedDB migrations run cleanly on existing installs.
 */
export const MACTION_DB_VERSION = 1;

/** IndexedDB database name for the Field PWA. */
export const MACTION_DB_NAME = 'maction-field-pwa';

/**
 * Offline database for the Field PWA. Tables mirror the backend master data schemas
 * (tenant-scoped via a `[company_id+id]` compound primary key) plus the local outbox.
 */
export class MactionDexieDb extends Dexie {
  /** master_customer — unified Outlet & Doctor entities. */
  customers!: Table<MasterCustomer, [string, string]>;

  /** doctor_profiles — 1:1 extension for doctor-type customers. */
  doctor_profiles!: Table<DoctorProfile, [string, string]>;

  /** doctor_outlet_assignments — M:N doctor-to-outlet affiliation. */
  doctor_outlet_assignments!: Table<DoctorOutletAssignment, [string, string]>;

  /** user_lini_assignments — M:N business-line scoping for the field user. */
  user_lini_assignments!: Table<UserLiniAssignment, [string, string]>;

  /** master_material — SKU catalog, filtered by the user's assigned lini. */
  materials!: Table<MasterMaterial, [string, string]>;

  /** visit_plans — today's MVP/SCP scheduled visits. */
  visit_plans!: Table<VisitPlan, [string, string]>;

  /** outbox_mutations — local offline mutation queue awaiting background sync. */
  outbox_mutations!: Table<LocalOutboxMutation, string>;

  constructor() {
    super(MACTION_DB_NAME);

    this.version(MACTION_DB_VERSION).stores({
      // Compound PK [company_id+id] guarantees tenant isolation in shared stores.
      // Secondary indexes cover the offline lookups each screen performs.
      customers:
        '[company_id+id], company_id, customer_type, soffice_id, code, erp_customer_code, [company_id+customer_type], [company_id+soffice_id]',
      doctor_profiles:
        '[company_id+id], company_id, customer_id, [company_id+customer_id]',
      doctor_outlet_assignments:
        '[company_id+id], company_id, doctor_customer_id, outlet_customer_id, [company_id+doctor_customer_id], [company_id+outlet_customer_id]',
      user_lini_assignments:
        '[company_id+id], company_id, user_id, lini_id, [company_id+user_id], [company_id+lini_id]',
      materials:
        '[company_id+id], company_id, business_line, code, erp_material_code, [company_id+business_line]',
      visit_plans:
        '[company_id+id], company_id, user_id, customer_id, plan_date, [company_id+user_id], [company_id+plan_date], [company_id+user_id+plan_date]',
      // Local outbox: local id PK; sync_status + captured_at drive FIFO batch draining.
      outbox_mutations:
        'id, company_id, user_id, user_role, sync_status, mutation_type, captured_at, [sync_status+captured_at]'
    });
  }
}

/** Singleton Dexie database instance for the Field PWA. */
export const db = new MactionDexieDb();
