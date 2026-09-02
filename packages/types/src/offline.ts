import type { SyncStatus, UserRole } from './enums.js';

/** Mutation types captured in the PWA offline outbox */
export type MutationType =
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'VISIT_IN'
  | 'VISIT_OUT'
  | 'AGENDA_CREATE'
  | 'STOCK_AUDIT_CREATE'
  | 'COMPETITOR_AUDIT_CREATE'
  | 'ORDER_SUBMIT';

/** Represents the Dexie.js `outbox_mutations` table — offline sync queue */
export interface LocalOutboxMutation {
  id: string;
  company_id: string;
  user_id: string;
  /** Role of the user that captured the mutation — enables role-adaptive sync (e.g. ORDER_SUBMIT only for SALESMAN). */
  user_role: UserRole;
  mutation_type: MutationType;
  endpoint: string;
  http_method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload: Record<string, unknown>;
  sync_status: SyncStatus;
  captured_at: string;
  mono_delta_ms: number;
  synced_at: string | null;
  error_message: string | null;
  retry_count: number;
}

/** Connectivity state displayed in the PWA top navbar */
export type ConnectivityState = 'ONLINE' | 'OFFLINE' | 'SYNCING' | 'ERROR';
