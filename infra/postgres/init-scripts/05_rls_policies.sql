-- ============================================================================
-- 05_rls_policies.sql
-- KF Maction v2.0 — Row-Level Security (RLS) Policies
--
-- This script enables and enforces RLS on all tenant-scoped tables.
-- It implements:
--   1. Base tenant isolation (company_id filtering)
--   2. Lini-scoped compound policy for master_material (field roles restricted by lini assignment)
--   3. Orders role restriction (MR excluded from read/write)
--   4. Child table policies via parent-join subqueries
--
-- Session variables are set by Elysia.js tenant-guard middleware per request:
--   SET LOCAL app.current_company_id = <uuid>
--   SET LOCAL app.current_user_id = <uuid>
--   SET LOCAL app.current_user_role = <role_label>
--
-- SUPER_ADMIN operations that require cross-tenant access use a dedicated
-- service DB role (e.g., maction_service) without RLS enforcement.
--
-- Depends on: 01_extensions.sql, 02_schema_ddl.sql, 04_audit_tables.sql
-- ============================================================================

-- ============================================================================
-- HELPER: Reusable expression references (documented for clarity)
--
-- Tenant check:
--   company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
--
-- User check:
--   NULLIF(current_setting('app.current_user_id', true), '')::uuid
--
-- Role check:
--   NULLIF(current_setting('app.current_user_role', true), '')
-- ============================================================================


-- ============================================================================
-- 1. TENANCY & ORGANIZATIONAL HIERARCHY
-- ============================================================================

-- --------------------------------------------------------------------------
-- master_soffice
-- --------------------------------------------------------------------------
ALTER TABLE master_soffice ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_soffice FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_soffice ON master_soffice
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- master_lini
-- --------------------------------------------------------------------------
ALTER TABLE master_lini ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_lini FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_lini ON master_lini
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- master_varian
-- --------------------------------------------------------------------------
ALTER TABLE master_varian ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_varian FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_varian ON master_varian
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);


-- ============================================================================
-- 2. USER, RBAC & MULTI-LINI ASSIGNMENT
-- ============================================================================

-- --------------------------------------------------------------------------
-- app_users
-- --------------------------------------------------------------------------
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_app_users ON app_users
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- user_lini_assignments
-- --------------------------------------------------------------------------
ALTER TABLE user_lini_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_lini_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_user_lini_assignments ON user_lini_assignments
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- absensi (attendance)
-- --------------------------------------------------------------------------
ALTER TABLE absensi ENABLE ROW LEVEL SECURITY;
ALTER TABLE absensi FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_absensi ON absensi
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);


-- ============================================================================
-- 3. CUSTOMER (OUTLET & DOCTOR) & DOCTOR-OUTLET JUNCTION
-- ============================================================================

-- --------------------------------------------------------------------------
-- master_customer
-- --------------------------------------------------------------------------
ALTER TABLE master_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_customer FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_customer ON master_customer
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- doctor_profiles
-- --------------------------------------------------------------------------
ALTER TABLE doctor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_doctor_profiles ON doctor_profiles
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- doctor_outlet_assignments
-- --------------------------------------------------------------------------
ALTER TABLE doctor_outlet_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_outlet_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_doctor_outlet_assignments ON doctor_outlet_assignments
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- master_pic
-- --------------------------------------------------------------------------
ALTER TABLE master_pic ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_pic FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_pic ON master_pic
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);


-- ============================================================================
-- 4. PRODUCT CATALOG, PRICING, VARIANTS & INVENTORY
-- ============================================================================

-- --------------------------------------------------------------------------
-- master_material — COMPOUND POLICY: tenant + lini-scoped for field roles
--
-- Policy logic:
--   - ADMIN_PUSAT / ADMIN_CABANG: full access within their company_id
--   - SALESMAN / MR: restricted to materials whose lini_id is in their
--     user_lini_assignments (active assignments only)
--   - SUPER_ADMIN: uses a separate service connection without RLS
-- --------------------------------------------------------------------------
ALTER TABLE master_material ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_material FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_material ON master_material
    FOR ALL
    USING (
        company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND (
            -- Admin roles see all materials within tenant
            NULLIF(current_setting('app.current_user_role', true), '') IN ('ADMIN_PUSAT', 'ADMIN_CABANG')
            OR (
                -- Field roles (SALESMAN, MR) see only materials in assigned lini
                NULLIF(current_setting('app.current_user_role', true), '') IN ('SALESMAN', 'MR')
                AND (
                    lini_id IS NULL  -- Materials without lini assignment are visible to all
                    OR lini_id IN (
                        SELECT ula.lini_id
                        FROM user_lini_assignments ula
                        WHERE ula.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                          AND ula.is_active = TRUE
                    )
                )
            )
        )
    )
    WITH CHECK (
        company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND (
            NULLIF(current_setting('app.current_user_role', true), '') IN ('ADMIN_PUSAT', 'ADMIN_CABANG')
            OR (
                NULLIF(current_setting('app.current_user_role', true), '') IN ('SALESMAN', 'MR')
                AND (
                    lini_id IS NULL
                    OR lini_id IN (
                        SELECT ula.lini_id
                        FROM user_lini_assignments ula
                        WHERE ula.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                          AND ula.is_active = TRUE
                    )
                )
            )
        )
    );

-- --------------------------------------------------------------------------
-- master_price
-- --------------------------------------------------------------------------
ALTER TABLE master_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_price FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_price ON master_price
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- stock_inventory_atp
-- --------------------------------------------------------------------------
ALTER TABLE stock_inventory_atp ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_inventory_atp FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_stock_inventory_atp ON stock_inventory_atp
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- master_promotions
-- --------------------------------------------------------------------------
ALTER TABLE master_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_promotions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_master_promotions ON master_promotions
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);


-- ============================================================================
-- 5. CALL PLANS & FIELD VISITS
-- ============================================================================

-- --------------------------------------------------------------------------
-- visit_plans
-- --------------------------------------------------------------------------
ALTER TABLE visit_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_visit_plans ON visit_plans
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- visits
-- --------------------------------------------------------------------------
ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_visits ON visits
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- visit_agendas — no direct company_id; secured via parent visits table join
-- --------------------------------------------------------------------------
ALTER TABLE visit_agendas ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_agendas FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_visit_agendas ON visit_agendas
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM visits v
            WHERE v.id = visit_agendas.visit_id
              AND v.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM visits v
            WHERE v.id = visit_agendas.visit_id
              AND v.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        )
    );

-- --------------------------------------------------------------------------
-- visit_stock_audits — no direct company_id; secured via parent visits table join
-- --------------------------------------------------------------------------
ALTER TABLE visit_stock_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_stock_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_visit_stock_audits ON visit_stock_audits
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM visits v
            WHERE v.id = visit_stock_audits.visit_id
              AND v.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM visits v
            WHERE v.id = visit_stock_audits.visit_id
              AND v.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        )
    );

-- --------------------------------------------------------------------------
-- visit_competitor_audits — no direct company_id; secured via parent visits table join
-- --------------------------------------------------------------------------
ALTER TABLE visit_competitor_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_competitor_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_visit_competitor_audits ON visit_competitor_audits
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM visits v
            WHERE v.id = visit_competitor_audits.visit_id
              AND v.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM visits v
            WHERE v.id = visit_competitor_audits.visit_id
              AND v.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        )
    );


-- ============================================================================
-- 6. ORDERS & SFA — ROLE RESTRICTION (MR EXCLUDED)
-- ============================================================================

-- --------------------------------------------------------------------------
-- orders — compound policy: tenant isolation + MR role exclusion
--
-- Policy logic:
--   - MR cannot SELECT, INSERT, UPDATE, or DELETE order records
--   - All other roles (SALESMAN, ADMIN_CABANG, ADMIN_PUSAT) can access
--     orders within their company_id
--   - SUPER_ADMIN uses service connection without RLS
-- --------------------------------------------------------------------------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_orders ON orders
    FOR ALL
    USING (
        company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND NULLIF(current_setting('app.current_user_role', true), '') != 'MR'
    )
    WITH CHECK (
        company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND NULLIF(current_setting('app.current_user_role', true), '') != 'MR'
    );

-- --------------------------------------------------------------------------
-- order_items — no direct company_id; secured via parent orders table join
-- Also enforces MR exclusion through the orders table RLS chain
-- --------------------------------------------------------------------------
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_order_items ON order_items
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
              AND o.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
              AND NULLIF(current_setting('app.current_user_role', true), '') != 'MR'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM orders o
            WHERE o.id = order_items.order_id
              AND o.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
              AND NULLIF(current_setting('app.current_user_role', true), '') != 'MR'
        )
    );

-- --------------------------------------------------------------------------
-- order_sequences — tenant isolation + MR role exclusion
--
-- Mirrors the orders policy: MR cannot touch the counter (MR never creates
-- orders), and all counter rows are scoped to the caller's company_id.
-- --------------------------------------------------------------------------
ALTER TABLE order_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_order_sequences ON order_sequences
    FOR ALL
    USING (
        company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND NULLIF(current_setting('app.current_user_role', true), '') != 'MR'
    )
    WITH CHECK (
        company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND NULLIF(current_setting('app.current_user_role', true), '') != 'MR'
    );


-- ============================================================================
-- 7. AUDIT TABLES
-- ============================================================================

-- --------------------------------------------------------------------------
-- audit_mutation_logs
-- --------------------------------------------------------------------------
ALTER TABLE audit_mutation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_mutation_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_mutation_logs ON audit_mutation_logs
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- audit_fraud_telemetry
-- --------------------------------------------------------------------------
ALTER TABLE audit_fraud_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_fraud_telemetry FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_fraud_telemetry ON audit_fraud_telemetry
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- audit_erp_sync_logs
-- --------------------------------------------------------------------------
ALTER TABLE audit_erp_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_erp_sync_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_erp_sync_logs ON audit_erp_sync_logs
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- audit_visit_lifecycle
-- --------------------------------------------------------------------------
ALTER TABLE audit_visit_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_visit_lifecycle FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_visit_lifecycle ON audit_visit_lifecycle
    FOR ALL
    USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
    WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
