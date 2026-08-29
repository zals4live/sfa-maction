import type { FraudType } from './enums.js';

/** Action types for mutation audit log */
export type AuditActionType = 'INSERT' | 'UPDATE' | 'DELETE';

/** Represents the `audit_mutation_logs` table — application change tracking */
export interface AuditMutationLog {
  id: string;
  company_id: string;
  user_id: string;
  client_ip: string | null;
  entity_name: string;
  record_id: string;
  action_type: AuditActionType;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

/** Represents the `audit_fraud_telemetry` table — GPS/clock fraud events */
export interface AuditFraudTelemetry {
  id: string;
  company_id: string;
  user_id: string;
  fraud_type: FraudType;
  claimed_lat: number | null;
  claimed_lng: number | null;
  accuracy_meters: number | null;
  calculated_speed_kmh: number | null;
  device_info: Record<string, unknown> | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
}

/** Represents the `audit_erp_sync_logs` table — ERP integration audit trail */
export interface AuditErpSyncLog {
  id: string;
  company_id: string;
  sync_direction: 'INBOUND' | 'OUTBOUND';
  endpoint_url: string;
  http_method: string;
  request_payload: Record<string, unknown> | null;
  response_payload: Record<string, unknown> | null;
  http_status: number | null;
  latency_ms: number | null;
  retry_count: number;
  is_success: boolean;
  idempotency_key: string | null;
  created_at: string;
}
