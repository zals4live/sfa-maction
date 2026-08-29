import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  doublePrecision,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'
import { geometry } from 'drizzle-orm/pg-core'
import { companies } from './tenant'
import { appUsers } from './auth'
import { visits } from './visit'

// --- Enums ---

export const fraudTypeEnum = pgEnum('fraud_type_enum', [
  'MOCK_LOCATION',
  'VELOCITY_ANOMALY',
  'ACCURACY_EXCESS',
  'CLOCK_DRIFT',
])

// --- Tables ---

export const auditMutationLogs = pgTable(
  'audit_mutation_logs',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => appUsers.id),
    entityName: varchar('entity_name', { length: 100 }).notNull(),
    recordId: uuid('record_id').notNull(),
    actionType: varchar('action_type', { length: 10 }).notNull(),
    beforeSnapshot: jsonb('before_snapshot'),
    afterSnapshot: jsonb('after_snapshot'),
    clientIp: varchar('client_ip', { length: 45 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_audit_mutation_company_date').on(table.companyId, table.createdAt),
    index('idx_audit_mutation_entity').on(table.companyId, table.entityName, table.recordId),
    index('idx_audit_mutation_user').on(table.userId, table.createdAt),
  ],
)

export const auditFraudTelemetry = pgTable(
  'audit_fraud_telemetry',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUsers.id),
    fraudType: fraudTypeEnum('fraud_type').notNull(),
    severity: varchar({ length: 20 }).default('LOW'),
    claimedLat: doublePrecision('claimed_lat'),
    claimedLng: doublePrecision('claimed_lng'),
    claimedAccuracyMeters: doublePrecision('claimed_accuracy_meters'),
    calculatedSpeedKmh: doublePrecision('calculated_speed_kmh'),
    distanceFromTargetMeters: doublePrecision('distance_from_target_meters'),
    clientTimestamp: timestamp('client_timestamp', { withTimezone: true, mode: 'string' }),
    serverTimestamp: timestamp('server_timestamp', { withTimezone: true, mode: 'string' }).defaultNow(),
    monoDeltaMs: doublePrecision('mono_delta_ms'),
    clockDriftSeconds: doublePrecision('clock_drift_seconds'),
    deviceInfo: jsonb('device_info'),
    isMockProvider: boolean('is_mock_provider').default(false),
    rawPayload: jsonb('raw_payload'),
    requestEndpoint: varchar('request_endpoint', { length: 255 }),
    clientIp: varchar('client_ip', { length: 45 }),
    actionTaken: varchar('action_taken', { length: 50 }).default('SOFT_REJECT'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_fraud_company_date').on(table.companyId, table.createdAt),
    index('idx_fraud_user').on(table.userId, table.createdAt),
    index('idx_fraud_type').on(table.companyId, table.fraudType, table.createdAt),
    index('idx_fraud_severity').on(table.companyId, table.severity),
  ],
)

export const auditErpSyncLogs = pgTable(
  'audit_erp_sync_logs',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    syncDirection: varchar('sync_direction', { length: 10 }).notNull(),
    syncType: varchar('sync_type', { length: 50 }).notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    httpMethod: varchar('http_method', { length: 10 }).default('POST'),
    requestPayload: jsonb('request_payload'),
    responsePayload: jsonb('response_payload'),
    httpStatusCode: integer('http_status_code'),
    latencyMs: integer('latency_ms'),
    retryCount: integer('retry_count').default(0),
    idempotencyKey: uuid('idempotency_key'),
    isSuccess: boolean('is_success').default(false),
    errorMessage: text('error_message'),
    errorCode: varchar('error_code', { length: 100 }),
    relatedEntity: varchar('related_entity', { length: 50 }),
    relatedRecordId: uuid('related_record_id'),
    bullmqJobId: varchar('bullmq_job_id', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_erp_sync_company_date').on(table.companyId, table.createdAt),
    index('idx_erp_sync_direction').on(table.companyId, table.syncDirection, table.syncType, table.createdAt),
    index('idx_erp_sync_failures').on(table.companyId, table.isSuccess, table.createdAt),
    index('idx_erp_sync_idempotency').on(table.idempotencyKey),
    index('idx_erp_sync_related').on(table.relatedEntity, table.relatedRecordId),
  ],
)

export const auditVisitLifecycle = pgTable(
  'audit_visit_lifecycle',
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    visitId: uuid('visit_id').notNull().references(() => visits.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUsers.id),
    stepName: varchar('step_name', { length: 50 }).notNull(),
    stepTimestamp: timestamp('step_timestamp', { withTimezone: true, mode: 'string' }).notNull(),
    stepSequence: integer('step_sequence').notNull(),
    durationFromPrevMs: integer('duration_from_prev_ms'),
    geom: geometry({ type: 'point', srid: 4326 }),
    metadata: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (table) => [
    index('idx_visit_lifecycle_visit').on(table.visitId, table.stepSequence),
    index('idx_visit_lifecycle_company_date').on(table.companyId, table.stepTimestamp),
    index('idx_visit_lifecycle_user').on(table.userId, table.stepTimestamp),
  ],
)
