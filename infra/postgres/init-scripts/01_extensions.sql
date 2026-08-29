-- ============================================================================
-- 01_extensions.sql
-- KF Maction v2.0 — PostgreSQL Extensions & Enum Type Definitions
--
-- This script runs automatically on database initialization via
-- Docker's /docker-entrypoint-initdb.d mechanism.
--
-- It installs required extensions and defines all application-level
-- enum types used across the schema.
-- ============================================================================

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ============================================================================
-- ENUM TYPES
-- ============================================================================

-- ERP system integration types supported per tenant
CREATE TYPE erp_system_enum AS ENUM ('SAP_S4HANA', 'SAP_ECC', 'QAD', 'CUSTOM_REST');

-- User role labels for RBAC
CREATE TYPE user_label_enum AS ENUM ('SUPER_ADMIN', 'ADMIN_PUSAT', 'ADMIN_CABANG', 'SALESMAN', 'MR');

-- Attendance check-in location categories
CREATE TYPE attendance_type_enum AS ENUM ('OFFICE', 'CUSTOMER', 'OTHER');

-- Master customer entity types
CREATE TYPE customer_type_enum AS ENUM ('OUTLET', 'DOCTOR', 'COMMUNITY', 'EVENT');

-- Visit classification against monthly call plan
CREATE TYPE visit_type_enum AS ENUM ('PLANNED', 'EXTRA');

-- Offline-to-server synchronization status
CREATE TYPE sync_status_enum AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- Order lifecycle states
CREATE TYPE order_status_enum AS ENUM ('DRAFT', 'SUBMITTED', 'SYNCED_ERP', 'REJECTED_ERP', 'CANCELLED');

-- Promotion mechanism types
CREATE TYPE promo_type_enum AS ENUM ('PERCENT_DISCOUNT', 'FIXED_AMOUNT', 'FREE_GOODS', 'BUNDLING');

-- Anti-spoofing fraud detection categories
CREATE TYPE fraud_type_enum AS ENUM ('MOCK_LOCATION', 'VELOCITY_ANOMALY', 'ACCURACY_EXCESS', 'CLOCK_DRIFT');
