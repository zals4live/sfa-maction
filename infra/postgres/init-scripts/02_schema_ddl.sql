-- ============================================================================
-- 02_schema_ddl.sql
-- KF Maction v2.0 — Core Table Definitions (DDL)
--
-- This script creates all application tables, indexes, and constraints.
-- It runs after 01_extensions.sql which provides extensions (uuid-ossp, postgis)
-- and all enum type definitions.
--
-- Tables are organized into 6 logical sections matching PRD Section 6:
--   1. Tenancy, Organizational Hierarchy & Business Lines
--   2. User, RBAC, Multi-Lini Assignment & Attendance
--   3. Customer (Outlet & Doctor) & Doctor-Outlet Junction
--   4. Product Catalog, Pricing, Variants & Inventory
--   5. Call Plans, Field Visits & In-Visit Logs
--   6. Orders & SFA Taking Order
--
-- NOTE: Materialized views → 03_reporting_views.sql
--       Audit tables       → 04_audit_tables.sql
--       RLS policies       → 05_rls_policies.sql
-- ============================================================================

-- ============================================================================
-- 1. TENANCY, ORGANIZATIONAL HIERARCHY & BUSINESS LINES
-- ============================================================================

CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,               -- e.g., 'KFTD', 'KFSP', 'KFA'
    name VARCHAR(255) NOT NULL,
    logo_s3_key TEXT,
    erp_system_type erp_system_enum DEFAULT 'SAP_S4HANA',
    erp_endpoint_url TEXT,
    erp_auth_config JSONB,                          -- Encrypted Tokens / Secrets
    erp_company_code VARCHAR(50),                   -- ERP Sales Org / Company Code
    default_tax_rate DECIMAL(5,2) DEFAULT 11.00,
    geofence_radius_meters INT DEFAULT 100,
    checkout_min_hour INT DEFAULT 16,               -- Minimum hour (0-23) before checkout is allowed
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE master_soffice (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,                      -- e.g., 'JKT01', 'BDG01'
    name VARCHAR(150) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    location_geom GEOMETRY(Point, 4326),            -- Branch PostGIS Coordinates
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_soffice_company ON master_soffice(company_id);
CREATE UNIQUE INDEX uq_soffice_active_code ON master_soffice(company_id, code) WHERE deleted_at IS NULL;

-- Master Lini Bisnis (e.g., 'FARMA_ETHICAL', 'FARMA_GENERIK', 'OTC', 'ALKES')
CREATE TABLE master_lini (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_lini_company ON master_lini(company_id, is_active);
CREATE UNIQUE INDEX uq_lini_active_code ON master_lini(company_id, code) WHERE deleted_at IS NULL;

-- Master Varian Produk / Kemasan (e.g., 'REGULAR', 'TENDER', 'EXPORT')
CREATE TABLE master_varian (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_varian_company ON master_varian(company_id, is_active);
CREATE UNIQUE INDEX uq_varian_active_code ON master_varian(company_id, code) WHERE deleted_at IS NULL;

-- ============================================================================
-- 2. USER, RBAC, MULTI-LINI ASSIGNMENT & ATTENDANCE
-- ============================================================================

CREATE TABLE app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    soffice_id UUID REFERENCES master_soffice(id),
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(30),
    role_label user_label_enum NOT NULL,            -- 'SUPER_ADMIN', 'ADMIN_PUSAT', 'ADMIN_CABANG', 'SALESMAN', 'MR'
    avatar_s3_key TEXT,
    current_session_ip VARCHAR(45),
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_company_soffice ON app_users(company_id, soffice_id);
CREATE INDEX idx_users_role ON app_users(company_id, role_label);

-- Junction Table: Multi-Lini Assignment per User (M:N)
CREATE TABLE user_lini_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    lini_id UUID NOT NULL REFERENCES master_lini(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_lini UNIQUE(company_id, user_id, lini_id)
);
CREATE INDEX idx_user_lini_user ON user_lini_assignments(user_id);
CREATE INDEX idx_user_lini_lookup ON user_lini_assignments(company_id, user_id, lini_id);

CREATE TABLE absensi (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    attendance_date DATE NOT NULL,
    attendance_type attendance_type_enum NOT NULL,
    check_in_time TIMESTAMPTZ NOT NULL,
    check_in_geom GEOMETRY(Point, 4326) NOT NULL,
    check_in_photo_s3_key TEXT NOT NULL,
    check_in_distance_meters INT,
    check_out_time TIMESTAMPTZ,
    check_out_geom GEOMETRY(Point, 4326),
    check_out_photo_s3_key TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_attendance_date UNIQUE(company_id, user_id, attendance_date)
);
CREATE INDEX idx_absensi_company_date ON absensi(company_id, attendance_date);

-- ============================================================================
-- 3. CUSTOMER (OUTLET & DOCTOR) & DOCTOR-OUTLET JUNCTION
-- ============================================================================

CREATE TABLE master_customer (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    soffice_id UUID NOT NULL REFERENCES master_soffice(id),
    customer_type customer_type_enum NOT NULL DEFAULT 'OUTLET', -- 'OUTLET' vs 'DOCTOR'
    erp_customer_code VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    customer_group VARCHAR(100),                    -- 'APOTEK', 'RUMAH SAKIT', 'KLINIK', 'DOKTER_SPESIALIS'
    address TEXT,
    city VARCHAR(100),
    location_geom GEOMETRY(Point, 4326),            -- Geolocation Pinpoint (Mandatory for OUTLET)
    credit_limit NUMERIC(15,2) DEFAULT 0,
    credit_term_days INT DEFAULT 30,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_customer_company ON master_customer(company_id, customer_type, is_active);
CREATE INDEX idx_customer_spatial ON master_customer USING GIST(location_geom);
CREATE UNIQUE INDEX uq_customer_active_code ON master_customer(company_id, erp_customer_code) WHERE deleted_at IS NULL;

-- Detail Profil Tambahan Dokter (1:1 dengan master_customer WHERE customer_type = 'DOCTOR')
CREATE TABLE doctor_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID UNIQUE NOT NULL REFERENCES master_customer(id) ON DELETE CASCADE,
    sip_str_number VARCHAR(100),
    specialization VARCHAR(100),                    -- 'Sp.A', 'Sp.OG', 'Sp.PD', 'Dokter Umum'
    sub_specialization VARCHAR(100),
    practice_schedule JSONB,                        -- Hari & jam praktik per outlet
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_doctor_profile_specialization ON doctor_profiles(company_id, specialization);

-- Junction Table: Relasi M:N Dokter <---> Fasilitas (Outlet)
CREATE TABLE doctor_outlet_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    doctor_customer_id UUID NOT NULL REFERENCES master_customer(id) ON DELETE CASCADE,
    outlet_customer_id UUID NOT NULL REFERENCES master_customer(id) ON DELETE CASCADE,
    room_or_department VARCHAR(100),                -- 'Poli Anak R. 201', 'Klinik Eksekutif'
    is_primary_practice BOOLEAN DEFAULT FALSE,
    practice_days VARCHAR(50),                     -- 'SENIN, RABU, JUMAT'
    practice_hours_start TIME,
    practice_hours_end TIME,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_doctor_outlet UNIQUE(company_id, doctor_customer_id, outlet_customer_id)
);
CREATE INDEX idx_doc_outlet_doc ON doctor_outlet_assignments(doctor_customer_id);
CREATE INDEX idx_doc_outlet_outlet ON doctor_outlet_assignments(outlet_customer_id);

-- PIC Staf Fasilitas / Outlet (Apoteker, Petugas Purchasing, dll)
CREATE TABLE master_pic (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES master_customer(id) ON DELETE CASCADE,
    pic_name VARCHAR(150) NOT NULL,
    position_title VARCHAR(100),
    phone VARCHAR(50),
    is_primary BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_pic_customer ON master_pic(customer_id);

-- ============================================================================
-- 4. PRODUCT CATALOG, PRICING, VARIANTS & INVENTORY
-- ============================================================================

CREATE TABLE master_material (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    erp_material_code VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    base_uom VARCHAR(20) NOT NULL,                  -- Satuan Dasar e.g., 'PCS' / 'TABLET'
    sales_uom VARCHAR(20) NOT NULL,                 -- Satuan Penjualan e.g., 'BOX'
    nie VARCHAR(100),                               -- Nomor Izin Edar BPOM
    valid_nie DATE,                                 -- Masa Berlaku NIE
    lini_id UUID REFERENCES master_lini(id),        -- Referensi ke master_lini
    manufacture VARCHAR(255),                       -- Manufaktur Pembuat
    principal VARCHAR(255),                         -- Pemilik Brand / Prinsipal
    uom_conversion_rules JSONB NOT NULL,            -- e.g., {"base_uom": "TABLET", "conversions": {"KARTON": 1000, "BOX": 100, "STRIP": 10, "TABLET": 1}}
    is_narcotic_psychotropic BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_material_company ON master_material(company_id, lini_id, is_active);
CREATE UNIQUE INDEX uq_material_active_code ON master_material(company_id, erp_material_code) WHERE deleted_at IS NULL;

CREATE TABLE master_price (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    soffice_id UUID NOT NULL REFERENCES master_soffice(id),
    material_id UUID NOT NULL REFERENCES master_material(id) ON DELETE CASCADE,
    varian_id UUID REFERENCES master_varian(id),    -- Referensi ke master_varian
    price_regular NUMERIC(15,2) NOT NULL,
    price_hja NUMERIC(15,2),
    price_het NUMERIC(15,2),
    per INT NOT NULL DEFAULT 1,                     -- Jumlah Satuan (e.g., per 1 Box)
    sales_uom VARCHAR(20) NOT NULL,                 -- Satuan Harga Penjualan
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_price_branch_mat_var UNIQUE(company_id, soffice_id, material_id, varian_id, valid_from)
);
CREATE INDEX idx_price_lookup ON master_price(soffice_id, material_id, varian_id, valid_from, valid_to);

CREATE TABLE stock_inventory_atp (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    soffice_id UUID NOT NULL REFERENCES master_soffice(id),
    material_id UUID NOT NULL REFERENCES master_material(id) ON DELETE CASCADE,
    varian_id UUID REFERENCES master_varian(id),    -- Referensi ke master_varian
    batch VARCHAR(100) NOT NULL,                    -- Nomor Batch Produksi
    sled DATE,                                      -- Shelf Life Expiration Date
    qty_available NUMERIC(12,2) NOT NULL DEFAULT 0, -- Kuantitas Siap Jual (ATP)
    qty_allocated NUMERIC(12,2) NOT NULL DEFAULT 0, -- Kuantitas Ter-alokasi
    stock_value NUMERIC(15,2) DEFAULT 0,            -- Estimasi Nilai Nominal Stok
    uom VARCHAR(20) NOT NULL,
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_stock_batch UNIQUE(company_id, soffice_id, material_id, varian_id, batch)
);
CREATE INDEX idx_stock_lookup ON stock_inventory_atp(soffice_id, material_id, varian_id, sled);

CREATE TABLE master_promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    promo_code VARCHAR(100) NOT NULL,
    promo_name VARCHAR(255) NOT NULL,
    promo_type promo_type_enum NOT NULL,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount NUMERIC(15,2) DEFAULT 0,
    min_order_qty INT DEFAULT 1,
    free_material_id UUID REFERENCES master_material(id),
    free_material_qty INT DEFAULT 0,
    valid_start TIMESTAMPTZ NOT NULL,
    valid_end TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_promo_active_code ON master_promotions(company_id, promo_code) WHERE deleted_at IS NULL;

-- ============================================================================
-- 5. CALL PLANS, FIELD VISITS & IN-VISIT LOGS (SALESMAN & MR)
-- ============================================================================

CREATE TABLE visit_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id),
    customer_id UUID NOT NULL REFERENCES master_customer(id),         -- Target (Outlet atau Dokter)
    outlet_context_id UUID REFERENCES master_customer(id),            -- Outlet tempat praktik jika customer_id = Doctor
    plan_date DATE NOT NULL,
    is_lead_from_erp BOOLEAN DEFAULT FALSE,
    is_approved BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_plan_target UNIQUE(company_id, user_id, customer_id, outlet_context_id, plan_date)
);
CREATE INDEX idx_visit_plan_lookup ON visit_plans(company_id, user_id, plan_date);

CREATE TABLE visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id),                  -- Rep pelaksana (Role: SALESMAN / MR)
    customer_id UUID NOT NULL REFERENCES master_customer(id),         -- Customer yang dikunjungi (Outlet / Dokter)
    outlet_id UUID REFERENCES master_customer(id),                   -- Outlet fisik tempat kunjungan berlangsung
    pic_id UUID REFERENCES master_pic(id),                            -- Staf / Apoteker pendamping (opsional)
    visit_type visit_type_enum DEFAULT 'PLANNED',
    visit_date DATE NOT NULL,
    visit_in_at TIMESTAMPTZ NOT NULL,
    visit_in_geom GEOMETRY(Point, 4326) NOT NULL,
    visit_in_distance_meters INT,
    visit_out_at TIMESTAMPTZ,
    visit_out_geom GEOMETRY(Point, 4326),
    signature_s3_key TEXT,
    notes TEXT,
    sync_status sync_status_enum DEFAULT 'SYNCED',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_visits_company_date ON visits(company_id, visit_date);
CREATE INDEX idx_visits_user ON visits(user_id, visit_date);
CREATE INDEX idx_visits_customer_outlet ON visits(customer_id, outlet_id);

CREATE TABLE visit_agendas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    topic VARCHAR(255) NOT NULL,
    product_discussed_id UUID REFERENCES master_material(id),
    discussion_summary TEXT,
    photo_s3_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE visit_stock_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES master_material(id),
    physical_stock_qty INT NOT NULL,
    uom VARCHAR(20) NOT NULL,
    estimated_days_of_stock INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE visit_competitor_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    competitor_brand VARCHAR(150) NOT NULL,
    competitor_product VARCHAR(150) NOT NULL,
    price_to_pharmacy NUMERIC(15,2),
    consumer_price NUMERIC(15,2),
    active_promo_notes TEXT,
    photo_s3_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- 6. ORDERS & SFA TAKING ORDER (SALESMAN ONLY)
-- ============================================================================

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    soffice_id UUID NOT NULL REFERENCES master_soffice(id),
    user_id UUID NOT NULL REFERENCES app_users(id),                  -- Mandatory: app_users.role_label = 'SALESMAN'
    customer_id UUID NOT NULL REFERENCES master_customer(id),         -- Commercial Ordering Entity (Outlet)
    doctor_customer_id UUID REFERENCES master_customer(id),           -- Prescribing Doctor reference (opsional)
    visit_id UUID REFERENCES visits(id),
    order_number VARCHAR(100) UNIQUE NOT NULL,
    erp_quotation_number VARCHAR(100),
    order_date DATE NOT NULL,
    subtotal_amount NUMERIC(15,2) NOT NULL,
    total_discount_amount NUMERIC(15,2) DEFAULT 0,
    tax_rate DECIMAL(5,2) DEFAULT 11.00,
    tax_amount NUMERIC(15,2) NOT NULL,
    grand_total NUMERIC(15,2) NOT NULL,
    order_status order_status_enum DEFAULT 'DRAFT',
    erp_sync_timestamp TIMESTAMPTZ,
    erp_error_payload JSONB,
    pdf_quotation_s3_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_orders_company_status ON orders(company_id, order_status, order_date);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES master_material(id),
    qty INT NOT NULL,
    uom VARCHAR(20) NOT NULL,
    unit_price NUMERIC(15,2) NOT NULL,
    discount_percentage DECIMAL(5,2) DEFAULT 0,
    discount_amount NUMERIC(15,2) DEFAULT 0,
    subtotal NUMERIC(15,2) NOT NULL,
    promotion_id UUID REFERENCES master_promotions(id),
    is_free_goods BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- Per-tenant, per-day monotonic counter for gap-free order numbering.
-- Upserted atomically (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) so
-- concurrent order creation serializes on the row lock, guaranteeing unique
-- ORD-YYYYMMDD-NNNN numbers without a COUNT-based race.
CREATE TABLE order_sequences (
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    order_date DATE NOT NULL,
    last_sequence INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT pk_order_sequences PRIMARY KEY (company_id, order_date)
);
