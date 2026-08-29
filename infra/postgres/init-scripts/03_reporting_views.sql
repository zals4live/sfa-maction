-- ============================================================================
-- 03_reporting_views.sql
-- KF Maction v2.0 — Materialized Views & Indexes for Reporting
--
-- This script creates materialized views used by the executive dashboard,
-- branch performance matrix, call rate analytics, and order reporting.
--
-- Refresh Strategy:
--   All materialized views are refreshed periodically via BullMQ
--   (mvRefreshWorker.ts) with CONCURRENTLY to avoid locking reads.
--   Recommended refresh interval: every 5–15 minutes during business hours.
--
-- Depends on: 02_schema_ddl.sql (all core tables)
-- ============================================================================

-- ============================================================================
-- 1. mv_daily_branch_performance
--    Primary dashboard KPI view — aggregates daily metrics per branch.
--    Used by: /reports/dashboard-kpi, /reports/branch-performance
-- ============================================================================

CREATE MATERIALIZED VIEW mv_daily_branch_performance AS
SELECT
    ms.company_id,
    ms.id AS soffice_id,
    ms.code AS soffice_code,
    ms.name AS soffice_name,
    d.report_date,

    -- Attendance metrics
    COALESCE(att.total_checked_in, 0) AS total_checked_in,
    COALESCE(att.total_field_users, 0) AS total_field_users,

    -- Visit metrics
    COALESCE(vis.total_visits, 0) AS total_visits,
    COALESCE(vis.planned_visits, 0) AS planned_visits,
    COALESCE(vis.extra_visits, 0) AS extra_visits,
    COALESCE(vis.completed_visits, 0) AS completed_visits,

    -- Plan metrics (target)
    COALESCE(pln.total_planned, 0) AS total_planned,

    -- Call rate: (actual visits / planned target) × 100
    CASE
        WHEN COALESCE(pln.total_planned, 0) > 0
        THEN ROUND((COALESCE(vis.total_visits, 0)::NUMERIC / pln.total_planned) * 100, 2)
        ELSE 0
    END AS call_rate_pct,

    -- Order metrics
    COALESCE(ord.total_orders, 0) AS total_orders,
    COALESCE(ord.total_revenue, 0) AS total_revenue,
    COALESCE(ord.total_items_sold, 0) AS total_items_sold,
    COALESCE(ord.avg_order_value, 0) AS avg_order_value,

    -- Effective call rate: (visits with orders / total visits) × 100
    CASE
        WHEN COALESCE(vis.total_visits, 0) > 0
        THEN ROUND((COALESCE(ord.orders_from_visits, 0)::NUMERIC / vis.total_visits) * 100, 2)
        ELSE 0
    END AS effective_call_rate_pct

FROM master_soffice ms
CROSS JOIN (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '90 days',
        CURRENT_DATE,
        '1 day'::INTERVAL
    )::DATE AS report_date
) d

-- Attendance subquery
LEFT JOIN LATERAL (
    SELECT
        COUNT(a.id) AS total_checked_in,
        COUNT(DISTINCT u.id) FILTER (WHERE u.role_label IN ('SALESMAN', 'MR')) AS total_field_users
    FROM absensi a
    JOIN app_users u ON u.id = a.user_id AND u.company_id = ms.company_id
    WHERE a.company_id = ms.company_id
      AND u.soffice_id = ms.id
      AND a.attendance_date = d.report_date
) att ON TRUE

-- Visit subquery
LEFT JOIN LATERAL (
    SELECT
        COUNT(v.id) AS total_visits,
        COUNT(v.id) FILTER (WHERE v.visit_type = 'PLANNED') AS planned_visits,
        COUNT(v.id) FILTER (WHERE v.visit_type = 'EXTRA') AS extra_visits,
        COUNT(v.id) FILTER (WHERE v.visit_out_at IS NOT NULL) AS completed_visits
    FROM visits v
    JOIN app_users u ON u.id = v.user_id AND u.company_id = ms.company_id
    WHERE v.company_id = ms.company_id
      AND u.soffice_id = ms.id
      AND v.visit_date = d.report_date
) vis ON TRUE

-- Plan subquery
LEFT JOIN LATERAL (
    SELECT COUNT(vp.id) AS total_planned
    FROM visit_plans vp
    JOIN app_users u ON u.id = vp.user_id AND u.company_id = ms.company_id
    WHERE vp.company_id = ms.company_id
      AND u.soffice_id = ms.id
      AND vp.plan_date = d.report_date
) pln ON TRUE

-- Order subquery
LEFT JOIN LATERAL (
    SELECT
        COUNT(o.id) AS total_orders,
        COALESCE(SUM(o.grand_total), 0) AS total_revenue,
        COALESCE(SUM(oi_agg.items_count), 0) AS total_items_sold,
        CASE WHEN COUNT(o.id) > 0
            THEN ROUND(SUM(o.grand_total) / COUNT(o.id), 2)
            ELSE 0
        END AS avg_order_value,
        COUNT(o.id) FILTER (WHERE o.visit_id IS NOT NULL) AS orders_from_visits
    FROM orders o
    LEFT JOIN LATERAL (
        SELECT COUNT(oi.id) AS items_count
        FROM order_items oi
        WHERE oi.order_id = o.id
    ) oi_agg ON TRUE
    WHERE o.company_id = ms.company_id
      AND o.soffice_id = ms.id
      AND o.order_date = d.report_date
      AND o.order_status NOT IN ('CANCELLED')
) ord ON TRUE

WHERE ms.is_active = TRUE
  AND ms.is_deleted = FALSE;

-- Indexes for mv_daily_branch_performance
CREATE UNIQUE INDEX idx_mv_branch_perf_pk
    ON mv_daily_branch_performance(company_id, soffice_id, report_date);
CREATE INDEX idx_mv_branch_perf_date
    ON mv_daily_branch_performance(report_date DESC);
CREATE INDEX idx_mv_branch_perf_company_date
    ON mv_daily_branch_performance(company_id, report_date DESC);


-- ============================================================================
-- 2. mv_call_rate_analytics
--    Monthly call rate per user — planned vs actual visits.
--    Used by: /reports/call-rate
-- ============================================================================

CREATE MATERIALIZED VIEW mv_call_rate_analytics AS
SELECT
    u.company_id,
    u.soffice_id,
    u.id AS user_id,
    u.full_name AS user_name,
    u.role_label,
    DATE_TRUNC('month', vp.plan_date)::DATE AS plan_month,

    -- Targets
    COUNT(DISTINCT vp.id) AS total_planned_visits,
    COUNT(DISTINCT vp.customer_id) AS unique_customers_planned,

    -- Actuals
    COUNT(DISTINCT v.id) AS total_actual_visits,
    COUNT(DISTINCT v.id) FILTER (WHERE v.visit_type = 'PLANNED') AS planned_type_visits,
    COUNT(DISTINCT v.id) FILTER (WHERE v.visit_type = 'EXTRA') AS extra_type_visits,
    COUNT(DISTINCT v.id) FILTER (WHERE v.visit_out_at IS NOT NULL) AS completed_visits,
    COUNT(DISTINCT v.customer_id) AS unique_customers_visited,

    -- Call rate
    CASE
        WHEN COUNT(DISTINCT vp.id) > 0
        THEN ROUND((COUNT(DISTINCT v.id)::NUMERIC / COUNT(DISTINCT vp.id)) * 100, 2)
        ELSE 0
    END AS call_rate_pct,

    -- Effective call rate (visits resulting in orders)
    COUNT(DISTINCT v.id) FILTER (WHERE EXISTS (
        SELECT 1 FROM orders o WHERE o.visit_id = v.id AND o.order_status != 'CANCELLED'
    )) AS visits_with_orders,

    CASE
        WHEN COUNT(DISTINCT v.id) > 0
        THEN ROUND(
            (COUNT(DISTINCT v.id) FILTER (WHERE EXISTS (
                SELECT 1 FROM orders o WHERE o.visit_id = v.id AND o.order_status != 'CANCELLED'
            ))::NUMERIC / COUNT(DISTINCT v.id)) * 100, 2
        )
        ELSE 0
    END AS effective_call_rate_pct

FROM app_users u
JOIN visit_plans vp
    ON vp.user_id = u.id
    AND vp.company_id = u.company_id
LEFT JOIN visits v
    ON v.user_id = u.id
    AND v.company_id = u.company_id
    AND DATE_TRUNC('month', v.visit_date) = DATE_TRUNC('month', vp.plan_date)
WHERE u.role_label IN ('SALESMAN', 'MR')
  AND u.is_active = TRUE
  AND u.is_deleted = FALSE
  AND vp.plan_date >= (CURRENT_DATE - INTERVAL '6 months')
GROUP BY u.company_id, u.soffice_id, u.id, u.full_name, u.role_label, DATE_TRUNC('month', vp.plan_date);

-- Indexes for mv_call_rate_analytics
CREATE UNIQUE INDEX idx_mv_call_rate_pk
    ON mv_call_rate_analytics(company_id, user_id, plan_month);
CREATE INDEX idx_mv_call_rate_soffice_month
    ON mv_call_rate_analytics(company_id, soffice_id, plan_month DESC);
CREATE INDEX idx_mv_call_rate_performance
    ON mv_call_rate_analytics(company_id, plan_month DESC, call_rate_pct DESC);


-- ============================================================================
-- 3. mv_order_revenue_daily
--    Daily order & revenue aggregation per branch and user.
--    Used by: /reports/orders, dashboard revenue charts
-- ============================================================================

CREATE MATERIALIZED VIEW mv_order_revenue_daily AS
SELECT
    o.company_id,
    o.soffice_id,
    o.user_id,
    u.full_name AS user_name,
    o.order_date,

    -- Order counts by status
    COUNT(o.id) AS total_orders,
    COUNT(o.id) FILTER (WHERE o.order_status = 'DRAFT') AS draft_orders,
    COUNT(o.id) FILTER (WHERE o.order_status = 'SUBMITTED') AS submitted_orders,
    COUNT(o.id) FILTER (WHERE o.order_status = 'SYNCED_ERP') AS synced_orders,
    COUNT(o.id) FILTER (WHERE o.order_status = 'REJECTED_ERP') AS rejected_orders,
    COUNT(o.id) FILTER (WHERE o.order_status = 'CANCELLED') AS cancelled_orders,

    -- Revenue (excludes cancelled)
    COALESCE(SUM(o.subtotal_amount) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS subtotal_revenue,
    COALESCE(SUM(o.total_discount_amount) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS total_discount,
    COALESCE(SUM(o.tax_amount) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS total_tax,
    COALESCE(SUM(o.grand_total) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS net_revenue,

    -- Item metrics
    COALESCE(SUM(oi_agg.item_count) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS total_line_items,
    COALESCE(SUM(oi_agg.total_qty) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS total_qty_sold,

    -- Unique customers ordered
    COUNT(DISTINCT o.customer_id) FILTER (WHERE o.order_status != 'CANCELLED') AS unique_customers

FROM orders o
JOIN app_users u ON u.id = o.user_id
LEFT JOIN LATERAL (
    SELECT
        COUNT(oi.id) AS item_count,
        SUM(oi.qty) AS total_qty
    FROM order_items oi
    WHERE oi.order_id = o.id
) oi_agg ON TRUE
WHERE o.order_date >= (CURRENT_DATE - INTERVAL '90 days')
GROUP BY o.company_id, o.soffice_id, o.user_id, u.full_name, o.order_date;

-- Indexes for mv_order_revenue_daily
CREATE UNIQUE INDEX idx_mv_order_rev_pk
    ON mv_order_revenue_daily(company_id, soffice_id, user_id, order_date);
CREATE INDEX idx_mv_order_rev_date
    ON mv_order_revenue_daily(company_id, order_date DESC);
CREATE INDEX idx_mv_order_rev_branch_date
    ON mv_order_revenue_daily(company_id, soffice_id, order_date DESC);


-- ============================================================================
-- 4. mv_attendance_compliance
--    Monthly attendance compliance per user and branch.
--    Used by: /reports/dashboard-kpi (attendance section), admin audit
-- ============================================================================

CREATE MATERIALIZED VIEW mv_attendance_compliance AS
SELECT
    u.company_id,
    u.soffice_id,
    u.id AS user_id,
    u.full_name AS user_name,
    u.role_label,
    DATE_TRUNC('month', a.attendance_date)::DATE AS attendance_month,

    -- Attendance counts
    COUNT(a.id) AS days_present,
    COUNT(a.id) FILTER (WHERE a.check_out_time IS NOT NULL) AS days_with_checkout,
    COUNT(a.id) FILTER (WHERE a.attendance_type = 'OFFICE') AS office_days,
    COUNT(a.id) FILTER (WHERE a.attendance_type = 'CUSTOMER') AS field_days,
    COUNT(a.id) FILTER (WHERE a.attendance_type = 'OTHER') AS other_days,

    -- Timing metrics
    MIN(a.check_in_time::TIME) AS earliest_checkin,
    MAX(a.check_in_time::TIME) AS latest_checkin,
    AVG(EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time)) / 3600)
        FILTER (WHERE a.check_out_time IS NOT NULL) AS avg_hours_worked,

    -- Geofence compliance
    AVG(a.check_in_distance_meters) AS avg_checkin_distance_m,
    COUNT(a.id) FILTER (WHERE a.check_in_distance_meters <= 100) AS within_geofence_count,
    CASE
        WHEN COUNT(a.id) > 0
        THEN ROUND(
            (COUNT(a.id) FILTER (WHERE a.check_in_distance_meters <= 100)::NUMERIC / COUNT(a.id)) * 100, 2
        )
        ELSE 0
    END AS geofence_compliance_pct

FROM app_users u
JOIN absensi a
    ON a.user_id = u.id
    AND a.company_id = u.company_id
WHERE u.role_label IN ('SALESMAN', 'MR')
  AND u.is_active = TRUE
  AND u.is_deleted = FALSE
  AND a.attendance_date >= (CURRENT_DATE - INTERVAL '6 months')
GROUP BY u.company_id, u.soffice_id, u.id, u.full_name, u.role_label, DATE_TRUNC('month', a.attendance_date);

-- Indexes for mv_attendance_compliance
CREATE UNIQUE INDEX idx_mv_att_compliance_pk
    ON mv_attendance_compliance(company_id, user_id, attendance_month);
CREATE INDEX idx_mv_att_compliance_branch_month
    ON mv_attendance_compliance(company_id, soffice_id, attendance_month DESC);


-- ============================================================================
-- 5. mv_user_territory_performance
--    Individual salesman territory performance — customers coverage & revenue.
--    Used by: territory analytics, branch performance league table
-- ============================================================================

CREATE MATERIALIZED VIEW mv_user_territory_performance AS
SELECT
    u.company_id,
    u.soffice_id,
    u.id AS user_id,
    u.full_name AS user_name,
    u.role_label,
    DATE_TRUNC('month', v.visit_date)::DATE AS performance_month,

    -- Territory coverage
    COUNT(DISTINCT v.customer_id) AS unique_customers_visited,
    COUNT(DISTINCT mc.id) FILTER (WHERE mc.customer_type = 'OUTLET') AS outlets_visited,
    COUNT(DISTINCT mc.id) FILTER (WHERE mc.customer_type = 'DOCTOR') AS doctors_visited,

    -- Visit activity
    COUNT(v.id) AS total_visits,
    COUNT(v.id) FILTER (WHERE v.visit_out_at IS NOT NULL) AS completed_visits,
    AVG(EXTRACT(EPOCH FROM (v.visit_out_at - v.visit_in_at)) / 60)
        FILTER (WHERE v.visit_out_at IS NOT NULL) AS avg_visit_duration_min,

    -- Orders from visits
    COUNT(DISTINCT o.id) FILTER (WHERE o.order_status != 'CANCELLED') AS total_orders,
    COALESCE(SUM(o.grand_total) FILTER (WHERE o.order_status != 'CANCELLED'), 0) AS total_revenue,

    -- Strike rate: orders per visit
    CASE
        WHEN COUNT(v.id) > 0
        THEN ROUND((COUNT(DISTINCT o.id) FILTER (WHERE o.order_status != 'CANCELLED')::NUMERIC / COUNT(v.id)) * 100, 2)
        ELSE 0
    END AS strike_rate_pct,

    -- Average order value
    CASE
        WHEN COUNT(DISTINCT o.id) FILTER (WHERE o.order_status != 'CANCELLED') > 0
        THEN ROUND(
            SUM(o.grand_total) FILTER (WHERE o.order_status != 'CANCELLED')
            / COUNT(DISTINCT o.id) FILTER (WHERE o.order_status != 'CANCELLED'), 2
        )
        ELSE 0
    END AS avg_order_value

FROM app_users u
JOIN visits v
    ON v.user_id = u.id
    AND v.company_id = u.company_id
LEFT JOIN master_customer mc
    ON mc.id = v.customer_id
LEFT JOIN orders o
    ON o.visit_id = v.id
    AND o.company_id = u.company_id
WHERE u.role_label IN ('SALESMAN', 'MR')
  AND u.is_active = TRUE
  AND u.is_deleted = FALSE
  AND v.visit_date >= (CURRENT_DATE - INTERVAL '6 months')
GROUP BY u.company_id, u.soffice_id, u.id, u.full_name, u.role_label, DATE_TRUNC('month', v.visit_date);

-- Indexes for mv_user_territory_performance
CREATE UNIQUE INDEX idx_mv_territory_perf_pk
    ON mv_user_territory_performance(company_id, user_id, performance_month);
CREATE INDEX idx_mv_territory_perf_branch
    ON mv_user_territory_performance(company_id, soffice_id, performance_month DESC);
CREATE INDEX idx_mv_territory_perf_revenue
    ON mv_user_territory_performance(company_id, performance_month DESC, total_revenue DESC);


-- ============================================================================
-- REFRESH HELPER
-- To be called by mvRefreshWorker.ts via BullMQ scheduled job.
-- Use CONCURRENTLY to avoid blocking read queries during refresh.
-- Note: REFRESH CONCURRENTLY requires the unique index on each view.
-- ============================================================================

-- Example refresh commands (used by the BullMQ worker):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_branch_performance;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_call_rate_analytics;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_order_revenue_daily;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_attendance_compliance;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_territory_performance;
