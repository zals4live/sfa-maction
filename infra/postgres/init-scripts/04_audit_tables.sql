-- ============================================================================
-- 04_audit_tables.sql
-- KF Maction v2.0 — Audit, Fraud Telemetry & Lifecycle Tracking Tables
--
-- This script creates the triple-layer audit architecture:
--   1. Application Mutation Logs (before/after delta snapshots)
--   2. Fraud Telemetry (GPS anomaly & anti-spoofing events)
--   3. ERP Sync Audit (inbound/outbound integration tracking)
--   4. Visit Lifecycle Audit (timestamp progression tracking)
--
-- NOTE: These tables are high-volume. Consider table partitioning by
--       (company_id, created_at) using RANGE partitioning on created_at
--       once data volume exceeds retention thresholds (e.g., monthly partitions).
--
-- Depends on: 01_extensions.sql (fraud_type_enum), 02_schema_ddl.sql (companies, app_users, visits)
-- RLS policies → 05_rls_policies.sql
-- ============================================================================

-- ============================================================================
-- 1. APPLICATION MUTATION LOGS
--    Captures before/after JSONB snapshots for all write operations.
--    Populated by Elysia.js audit interceptor on INSERT/UPDATE/DELETE.
-- ============================================================================

CREATE TABLE audit_mutation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES app_users(id),
    entity_name VARCHAR(100) NOT NULL,              -- e.g., 'master_customer', 'orders', 'visit_plans'
    record_id UUID NOT NULL,                        -- Primary key of the affected record
    action_type VARCHAR(10) NOT NULL,               -- 'INSERT', 'UPDATE', 'DELETE'
    before_snapshot JSONB,                          -- NULL for INSERT operations
    after_snapshot JSONB,                           -- NULL for DELETE operations
    client_ip VARCHAR(45),                          -- IPv4 or IPv6 request source
    user_agent TEXT,                                -- Browser/device user agent string
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_action_type CHECK (action_type IN ('INSERT', 'UPDATE', 'DELETE'))
);

CREATE INDEX idx_audit_mutation_company_date ON audit_mutation_logs(company_id, created_at);
CREATE INDEX idx_audit_mutation_entity ON audit_mutation_logs(company_id, entity_name, record_id);
CREATE INDEX idx_audit_mutation_user ON audit_mutation_logs(user_id, created_at);

-- ============================================================================
-- 2. FRAUD TELEMETRY
--    Anti-spoofing event records for GPS anomalies and clock manipulation.
--    Reviewed by Admin Cabang through the fraud incident dashboard.
--    Populated by Elysia.js anti-spoof middleware and PWA client-side detection.
-- ============================================================================

CREATE TABLE audit_fraud_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id),
    fraud_type fraud_type_enum NOT NULL,            -- MOCK_LOCATION, VELOCITY_ANOMALY, ACCURACY_EXCESS, CLOCK_DRIFT
    severity VARCHAR(20) DEFAULT 'LOW',             -- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'

    -- Location context
    claimed_lat DOUBLE PRECISION,                   -- Latitude from device
    claimed_lng DOUBLE PRECISION,                   -- Longitude from device
    claimed_accuracy_meters DOUBLE PRECISION,       -- GPS accuracy reported by device
    calculated_speed_kmh DOUBLE PRECISION,          -- Server-computed speed (for VELOCITY_ANOMALY)
    distance_from_target_meters DOUBLE PRECISION,   -- Distance to expected geofence point

    -- Time context
    client_timestamp TIMESTAMPTZ,                   -- Device-reported timestamp
    server_timestamp TIMESTAMPTZ DEFAULT NOW(),     -- Server receipt time
    mono_delta_ms DOUBLE PRECISION,                 -- performance.now() monotonic delta
    clock_drift_seconds DOUBLE PRECISION,           -- Computed drift (for CLOCK_DRIFT)

    -- Device fingerprint
    device_info JSONB,                              -- { os, version, model, browser, screen, battery_level }
    is_mock_provider BOOLEAN DEFAULT FALSE,         -- OS-reported mock location flag

    -- Raw request context
    raw_payload JSONB,                              -- Full request body snapshot for forensic review
    request_endpoint VARCHAR(255),                  -- API endpoint that triggered detection
    client_ip VARCHAR(45),

    -- Resolution
    action_taken VARCHAR(50) DEFAULT 'SOFT_REJECT', -- 'SOFT_REJECT', 'LOGGED_ONLY', 'ESCALATED'

    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_severity CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    CONSTRAINT chk_action_taken CHECK (action_taken IN ('SOFT_REJECT', 'LOGGED_ONLY', 'ESCALATED'))
);

CREATE INDEX idx_fraud_company_date ON audit_fraud_telemetry(company_id, created_at);
CREATE INDEX idx_fraud_user ON audit_fraud_telemetry(user_id, created_at);
CREATE INDEX idx_fraud_type ON audit_fraud_telemetry(company_id, fraud_type, created_at);
CREATE INDEX idx_fraud_severity ON audit_fraud_telemetry(company_id, severity) WHERE severity IN ('HIGH', 'CRITICAL');

-- ============================================================================
-- 3. ERP SYNC AUDIT LOGS
--    Tracks every inbound (webhook) and outbound (order push) ERP integration.
--    Used for debugging sync failures, retry analysis, and latency monitoring.
-- ============================================================================

CREATE TABLE audit_erp_sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sync_direction VARCHAR(10) NOT NULL,            -- 'INBOUND' or 'OUTBOUND'
    sync_type VARCHAR(50) NOT NULL,                 -- e.g., 'CUSTOMER_SYNC', 'MATERIAL_SYNC', 'ORDER_PUSH', 'STOCK_SYNC', 'PRICE_SYNC', 'PROMO_SYNC'
    endpoint_url TEXT NOT NULL,                     -- Target ERP endpoint URL
    http_method VARCHAR(10) DEFAULT 'POST',         -- HTTP method used

    -- Request/Response
    request_payload JSONB,                          -- Outbound payload or inbound webhook body
    response_payload JSONB,                         -- ERP response body
    http_status_code INT,                           -- Response HTTP status (200, 400, 500, etc.)

    -- Performance & Reliability
    latency_ms INT,                                 -- Request duration in milliseconds
    retry_count INT DEFAULT 0,                      -- Number of retry attempts for this operation
    idempotency_key UUID,                           -- Idempotency key used (for outbound orders)

    -- Status
    is_success BOOLEAN DEFAULT FALSE,               -- Final success/failure determination
    error_message TEXT,                             -- Error description if failed
    error_code VARCHAR(100),                        -- Structured error code from ERP

    -- Reference
    related_entity VARCHAR(50),                     -- e.g., 'orders', 'master_customer', 'master_material'
    related_record_id UUID,                         -- ID of the affected local record
    bullmq_job_id VARCHAR(100),                    -- BullMQ job reference for outbound jobs

    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_sync_direction CHECK (sync_direction IN ('INBOUND', 'OUTBOUND'))
);

CREATE INDEX idx_erp_sync_company_date ON audit_erp_sync_logs(company_id, created_at);
CREATE INDEX idx_erp_sync_direction ON audit_erp_sync_logs(company_id, sync_direction, sync_type, created_at);
CREATE INDEX idx_erp_sync_failures ON audit_erp_sync_logs(company_id, is_success, created_at) WHERE is_success = FALSE;
CREATE INDEX idx_erp_sync_idempotency ON audit_erp_sync_logs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_erp_sync_related ON audit_erp_sync_logs(related_entity, related_record_id);

-- ============================================================================
-- 4. VISIT LIFECYCLE AUDIT
--    Tracks granular timestamp progression through the visit lifecycle.
--    Captures: check-in → arrival → each activity → order entry → signing → visit out.
--    Used for SLA analysis, field productivity, and anomaly detection.
--    Applicable to both SALESMAN and MR roles.
-- ============================================================================

CREATE TABLE audit_visit_lifecycle (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id),
    step_name VARCHAR(50) NOT NULL,                 -- 'VISIT_IN', 'AGENDA_START', 'AGENDA_END', 'STOCK_AUDIT', 'COMPETITOR_AUDIT', 'ORDER_START', 'ORDER_SUBMIT', 'SIGNATURE', 'VISIT_OUT'
    step_timestamp TIMESTAMPTZ NOT NULL,            -- When this step occurred
    step_sequence INT NOT NULL,                     -- Ordinal position in the lifecycle (1, 2, 3...)
    duration_from_prev_ms INT,                      -- Milliseconds since previous step (NULL for first step)
    geom GEOMETRY(Point, 4326),                     -- GPS coordinates at this step (if captured)
    metadata JSONB,                                 -- Step-specific context (e.g., { agenda_id, order_id })
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_visit_lifecycle_visit ON audit_visit_lifecycle(visit_id, step_sequence);
CREATE INDEX idx_visit_lifecycle_company_date ON audit_visit_lifecycle(company_id, step_timestamp);
CREATE INDEX idx_visit_lifecycle_user ON audit_visit_lifecycle(user_id, step_timestamp);
