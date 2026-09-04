import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { setRLSContext } from '../../../db/rls'
import { fetchBranchHeadlineTotals, fetchRoleVisitMetrics } from '../dashboardKpi'
import type { Transaction } from '../../../db'

/**
 * Performance test (Phase 16) — materialized view dashboard queries.
 *
 * The executive dashboard KPI (`GET /reports/dashboard-kpi`) is served from two
 * reporting materialized views defined in
 * infra/postgres/init-scripts/03_reporting_views.sql:
 *   - `mv_daily_branch_performance`   → branch-level headline totals
 *   - `mv_user_territory_performance` → per-role (SALESMAN/MR) segmentation
 *
 * A Redis cache (TTL 5–15 min) fronts the HTTP response, so this test measures
 * the WORST case: the cache-miss path that hits PostgreSQL directly. It runs the
 * SAME query helpers the report service uses (fetchBranchHeadlineTotals /
 * fetchRoleVisitMetrics from dashboardKpi.ts) so the measurement reflects the
 * production query shape, not a hand-rolled approximation.
 *
 * Methodology:
 *   1. Seed a representative tenant (multiple branches, field users, and daily
 *      visits/orders/plans/attendance across the MV's 90-day window).
 *   2. REFRESH the two materialized views (CONCURRENTLY is not usable on first
 *      populate under a fresh unique index set, so we use a plain REFRESH).
 *   3. Warm up, then run each dashboard query N times inside one RLS-scoped
 *      transaction, recording per-iteration latency.
 *   4. Assert the p95 latency is within the ≤ 150ms target.
 *   5. Verify (EXPLAIN) that the branch query uses the company/date index rather
 *      than a sequential scan.
 *
 * Environment: connects via DATABASE_URL and SKIPS cleanly when no migrated
 * database with the reporting MVs is reachable (e.g. CI without docker-compose
 * Postgres) instead of failing spuriously. Seed data is namespaced under a unique
 * company_id and removed in afterAll (ON DELETE CASCADE), so no artifacts persist.
 *
 * Requires: `docker compose -f infra/docker/docker-compose.yml up postgres` with
 * init-scripts applied, and a matching DATABASE_URL in the environment.
 */

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/maction_dev'

/** ≤ 150ms target for materialized view dashboard queries (task acceptance). */
const TARGET_P95_MS = 150

/** Iterations used to compute the latency distribution (excludes warmups). */
const MEASURE_ITERATIONS = 30

/** Warmup iterations discarded before measuring (JIT / plan cache / buffer warm). */
const WARMUP_ITERATIONS = 5

/** Representative seed size — enough rows to make the MV non-trivial. */
const SEED = {
  branches: 8,
  usersPerBranch: 6,
  days: 90,
} as const

interface Harness {
  client: postgres.Sql
  db: ReturnType<typeof drizzle>
}

let harness: Harness | null = null
let skipReason: string | null = null

/** Unique tenant id for this run so seed + cleanup never collide with real data. */
const companyId = crypto.randomUUID()
const adminUserId = crypto.randomUUID()

/**
 * Connects to the database and confirms the two reporting materialized views
 * exist. Records skipReason and returns null when the environment can't support
 * the test (unreachable DB or un-migrated schema).
 */
async function connect(): Promise<Harness | null> {
  const client = postgres(DATABASE_URL, { max: 1, connect_timeout: 5, ssl: false, prepare: false })
  try {
    const views = await client`
      SELECT matviewname::text AS v FROM pg_matviews
      WHERE matviewname::text IN ('mv_daily_branch_performance', 'mv_user_territory_performance')
    `
    const found = new Set(views.map((r) => r['v'] as string))
    const missing = ['mv_daily_branch_performance', 'mv_user_territory_performance'].filter(
      (v) => !found.has(v)
    )
    if (missing.length > 0) {
      skipReason = `reporting materialized views missing: ${missing.join(', ')} — run infra/postgres/init-scripts`
      await client.end()
      return null
    }
    return { client, db: drizzle(client) }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`
    await client.end().catch(() => {})
    return null
  }
}

/**
 * Seeds a representative tenant and refreshes the reporting MVs.
 *
 * Data volume: `branches × usersPerBranch` field users, each with one visit,
 * one order (with a line item), one plan, and one attendance row per day across
 * the MV's `days`-day window. That produces `branches × days` branch-performance
 * rows and `branches × usersPerBranch` territory rows to aggregate over.
 */
async function seed(h: Harness): Promise<void> {
  // EWKT string implicitly casts to geometry(Point,4326) on insert (verified).
  const geomEwkt = 'SRID=4326;POINT(106.8 -6.2)'
  const now = new Date().toISOString()

  // Accumulate rows in memory, then bulk-INSERT per table to minimise round-trips
  // (per-row inserts across ~13k rows are far too slow for a seed step).
  const soffices: Array<Record<string, unknown>> = []
  const customers: Array<Record<string, unknown>> = []
  const users: Array<Record<string, unknown>> = []
  const plans: Array<Record<string, unknown>> = []
  const attendances: Array<Record<string, unknown>> = []
  const visits: Array<Record<string, unknown>> = []
  const orders: Array<Record<string, unknown>> = []
  const items: Array<Record<string, unknown>> = []

  users.push({
    id: adminUserId,
    company_id: companyId,
    soffice_id: null,
    email: `admin-${companyId.slice(0, 8)}@perf.local`,
    password_hash: 'x'.repeat(60),
    full_name: 'Perf Admin',
    role_label: 'ADMIN_PUSAT',
  })

  for (let b = 0; b < SEED.branches; b++) {
    const sofficeId = crypto.randomUUID()
    const customerId = crypto.randomUUID()
    soffices.push({ id: sofficeId, company_id: companyId, code: `SOF-${b}-${companyId.slice(0, 4)}`, name: `Branch ${b}` })
    customers.push({ id: customerId, company_id: companyId, soffice_id: sofficeId, customer_type: 'OUTLET', name: `Outlet ${b}` })

    for (let u = 0; u < SEED.usersPerBranch; u++) {
      const userId = crypto.randomUUID()
      const role = u % 2 === 0 ? 'SALESMAN' : 'MR'
      users.push({
        id: userId,
        company_id: companyId,
        soffice_id: sofficeId,
        email: `u-${b}-${u}-${companyId.slice(0, 4)}@perf.local`,
        password_hash: 'x'.repeat(60),
        full_name: `User ${b}-${u}`,
        role_label: role,
      })

      for (let d = 0; d < SEED.days; d++) {
        const day = isoDaysAgo(d)
        const visitId = crypto.randomUUID()
        const visitType = d % 3 === 0 ? 'EXTRA' : 'PLANNED'

        plans.push({ id: crypto.randomUUID(), company_id: companyId, user_id: userId, customer_id: customerId, plan_date: day })
        attendances.push({
          id: crypto.randomUUID(),
          company_id: companyId,
          user_id: userId,
          attendance_date: day,
          attendance_type: 'CUSTOMER',
          check_in_time: now,
          check_in_geom: geomEwkt,
          check_in_photo_s3_key: 'photo.jpg',
          check_in_distance_meters: 25,
        })
        visits.push({
          id: visitId,
          company_id: companyId,
          user_id: userId,
          customer_id: customerId,
          visit_type: visitType,
          visit_date: day,
          visit_in_at: now,
          visit_in_geom: geomEwkt,
          visit_out_at: now,
          sync_status: 'SYNCED',
        })

        // Orders only for SALESMAN (MR is barred from orders by policy/domain).
        if (role === 'SALESMAN') {
          const orderId = crypto.randomUUID()
          orders.push({
            id: orderId,
            company_id: companyId,
            soffice_id: sofficeId,
            user_id: userId,
            customer_id: customerId,
            visit_id: visitId,
            order_number: `ORD-${orderId.slice(0, 12)}`,
            order_date: day,
            subtotal_amount: '100000.00',
            tax_amount: '11000.00',
            grand_total: '111000.00',
            order_status: 'SUBMITTED',
          })
          items.push({
            id: crypto.randomUUID(),
            order_id: orderId,
            material_id: crypto.randomUUID(),
            qty: 10,
            uom: 'PCS',
            unit_price: '10000.00',
            subtotal: '100000.00',
          })
        }
      }
    }
  }

  await h.client.begin(async (tx) => {
    await tx`INSERT INTO companies (id, code, name)
      VALUES (${companyId}, ${`PERF-${companyId.slice(0, 8)}`}, 'Perf Test Tenant')`
    await tx`INSERT INTO master_soffice ${tx(soffices, 'id', 'company_id', 'code', 'name')}`
    await tx`INSERT INTO master_customer ${tx(customers, 'id', 'company_id', 'soffice_id', 'customer_type', 'name')}`
    await tx`INSERT INTO app_users ${tx(users, 'id', 'company_id', 'soffice_id', 'email', 'password_hash', 'full_name', 'role_label')}`
    await tx`INSERT INTO visit_plans ${tx(plans, 'id', 'company_id', 'user_id', 'customer_id', 'plan_date')}`

    for (const chunk of toChunks(attendances, 1000)) {
      await tx`INSERT INTO absensi ${tx(chunk, 'id', 'company_id', 'user_id', 'attendance_date', 'attendance_type', 'check_in_time', 'check_in_geom', 'check_in_photo_s3_key', 'check_in_distance_meters')}`
    }
    for (const chunk of toChunks(visits, 1000)) {
      await tx`INSERT INTO visits ${tx(chunk, 'id', 'company_id', 'user_id', 'customer_id', 'visit_type', 'visit_date', 'visit_in_at', 'visit_in_geom', 'visit_out_at', 'sync_status')}`
    }

    for (const chunk of toChunks(orders, 1000)) {
      await tx`INSERT INTO orders ${tx(chunk, 'id', 'company_id', 'soffice_id', 'user_id', 'customer_id', 'visit_id', 'order_number', 'order_date', 'subtotal_amount', 'tax_amount', 'grand_total', 'order_status')}`
    }
    for (const chunk of toChunks(items, 1000)) {
      await tx`INSERT INTO order_items ${tx(chunk, 'id', 'order_id', 'material_id', 'qty', 'uom', 'unit_price', 'subtotal')}`
    }
  })

  // Populate the reporting views from the freshly seeded data. A plain REFRESH
  // (not CONCURRENTLY) is required for the initial populate of a view that has
  // never been refreshed, and cannot run inside a transaction block.
  await h.client.unsafe('REFRESH MATERIALIZED VIEW mv_daily_branch_performance')
  await h.client.unsafe('REFRESH MATERIALIZED VIEW mv_user_territory_performance')
}

/** Splits an array into fixed-size chunks (bounds each multi-row INSERT). */
function toChunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Returns the ISO date (YYYY-MM-DD) for `d` days before today (UTC). */
function isoDaysAgo(d: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - d)
  return date.toISOString().slice(0, 10)
}

/** Computes the p-th percentile (0–100) of a sample using nearest-rank. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[idx]!
}

beforeAll(async () => {
  harness = await connect()
  if (!harness) {
    // eslint-disable-next-line no-console
    console.warn(`[dashboardKpi.perf] SKIPPED — ${skipReason}`)
    return
  }
  await seed(harness)
}, 120_000)

afterAll(async () => {
  if (!harness) return
  // Remove all seeded rows (ON DELETE CASCADE from companies), then refresh the
  // MVs so no perf-test rows linger in the reporting views.
  try {
    await harness.client`DELETE FROM companies WHERE id = ${companyId}`
    await harness.client.unsafe('REFRESH MATERIALIZED VIEW mv_daily_branch_performance')
    await harness.client.unsafe('REFRESH MATERIALIZED VIEW mv_user_territory_performance')
  } finally {
    await harness.client.end()
  }
}, 60_000)

describe('report/dashboardKpi — materialized view query performance (live PostgreSQL)', () => {
  it('serves the dashboard KPI (both MV queries) within the ≤ 150ms p95 target', async () => {
    if (!harness) return // environment-gated skip (reason logged in beforeAll)
    const { db } = harness

    const latencies: number[] = []

    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Transaction
      await setRLSContext(tx, { companyId, userId: adminUserId, userRole: 'ADMIN_PUSAT' })

      // Warmup: prime plan cache and shared buffers so measurements are steady.
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await fetchBranchHeadlineTotals(tx, companyId, 30, null)
        await fetchRoleVisitMetrics(tx, companyId, 30, null)
      }

      // Measure the full dashboard-KPI cache-miss path (both MV queries) per iteration.
      for (let i = 0; i < MEASURE_ITERATIONS; i++) {
        const start = performance.now()
        await Promise.all([
          fetchBranchHeadlineTotals(tx, companyId, 30, null),
          fetchRoleVisitMetrics(tx, companyId, 30, null),
        ])
        latencies.push(performance.now() - start)
      }
    })

    const p50 = percentile(latencies, 50)
    const p95 = percentile(latencies, 95)
    const max = Math.max(...latencies)

    // eslint-disable-next-line no-console
    console.info(
      `[dashboardKpi.perf] dashboard MV query latency over ${MEASURE_ITERATIONS} runs — ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms (target ≤ ${TARGET_P95_MS}ms)`
    )

    expect(p95).toBeLessThanOrEqual(TARGET_P95_MS)
  })

  it('returns correct aggregate shape from the seeded materialized views', async () => {
    if (!harness) return
    const { db } = harness

    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Transaction
      await setRLSContext(tx, { companyId, userId: adminUserId, userRole: 'ADMIN_PUSAT' })

      const totals = await fetchBranchHeadlineTotals(tx, companyId, 30, null)
      const roles = await fetchRoleVisitMetrics(tx, companyId, 30, null)

      // Seeded data guarantees active users, orders (SALESMAN only), and visits.
      expect(totals.total_active_users).toBeGreaterThan(0)
      expect(totals.total_orders).toBeGreaterThan(0)
      expect(totals.total_revenue).toBeGreaterThan(0)
      expect(roles.SALESMAN.total_visits).toBeGreaterThan(0)
      expect(roles.MR.total_visits).toBeGreaterThan(0)
      // Call rate is a valid percentage.
      expect(roles.SALESMAN.call_rate_pct).toBeGreaterThanOrEqual(0)
    })
  })

  it('uses the company/date index on mv_daily_branch_performance (no sequential scan)', async () => {
    if (!harness) return
    const { client } = harness

    // EXPLAIN the branch headline query shape against the MV. We assert the
    // planner reaches the MV via an index (idx_mv_branch_perf_company_date /
    // _date / pk) rather than a full sequential scan, which is what keeps the
    // query within the latency target as data grows.
    const plan = await client.unsafe(
      `EXPLAIN (FORMAT TEXT)
       SELECT COALESCE(MAX(mv.total_field_users), 0),
              COALESCE(SUM(mv.total_orders), 0),
              COALESCE(SUM(mv.total_revenue), 0)
       FROM mv_daily_branch_performance mv
       WHERE mv.company_id = '${companyId}'
         AND mv.report_date >= (CURRENT_DATE - MAKE_INTERVAL(days => 29))
         AND mv.report_date <= CURRENT_DATE`
    )
    const planText = plan.map((r) => r['QUERY PLAN'] as string).join('\n')

    expect(planText).toContain('mv_daily_branch_performance')
    expect(planText.toLowerCase()).toContain('index')
    expect(planText.toLowerCase()).not.toContain('seq scan')
  })
})
