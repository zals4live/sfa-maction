import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql, eq } from 'drizzle-orm'

import * as schema from '../schema'
import { setRLSContext, clearRLSContext } from '../rls'

/**
 * Integration test (Phase 16) — multi-tenant isolation: zero cross-tenant data
 * leakage enforced by PostgreSQL Row-Level Security.
 *
 * This exercises the REAL base tenant-isolation policies from
 * infra/postgres/init-scripts/05_rls_policies.sql against a live PostgreSQL
 * instance. It proves the database — not application code — hides rows belonging
 * to another `company_id` once the RLS session context is switched.
 *
 * IMPORTANT — RLS and privileged roles:
 *   PostgreSQL bypasses ALL row-level security for superusers and roles with the
 *   BYPASSRLS attribute, even under FORCE ROW LEVEL SECURITY. Local dev databases
 *   are typically owned by such a role, so reads on the base connection would
 *   (correctly) return every row and never exercise the policy. To genuinely prove
 *   isolation, all tenant-scoped reads/writes run through a dedicated, unprivileged
 *   NOBYPASSRLS role via `SET LOCAL ROLE` inside the transaction — mirroring how the
 *   API server connects as a restricted application role in production.
 *
 * The test connects using DATABASE_URL and skips cleanly when no migrated database
 * with RLS policies is reachable (e.g. CI without the docker-compose Postgres),
 * rather than failing spuriously. All writes run inside a single transaction that is
 * rolled back, so no artifacts persist.
 *
 * Requires: `docker compose -f infra/docker/docker-compose.yml up postgres` with
 * init-scripts applied, and a matching DATABASE_URL in the environment.
 */

const { companies, masterSoffice, masterCustomer, visits, orders } = schema

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/maction_dev'

/** Unprivileged role used to actually exercise RLS (created on demand, no login). */
const RLS_TEST_ROLE = 'maction_tenant_rls_test_role'

/** Tables the seed + assertions touch — granted to the unprivileged role. */
const GRANT_TABLES = [
  'companies',
  'master_soffice',
  'master_customer',
  'app_users',
  'visits',
  'orders',
]

// Sentinel error thrown to force a transaction rollback after assertions run.
class RollbackSignal extends Error {}

interface Harness {
  client: postgres.Sql
  db: ReturnType<typeof drizzle>
}

let harness: Harness | null = null
let skipReason: string | null = null

/**
 * Establishes a live connection, confirms the schema + base RLS policies are
 * present, and ensures an unprivileged role exists to genuinely exercise RLS.
 * Returns null (and records skipReason) when the environment can't support the test.
 */
async function connect(): Promise<Harness | null> {
  const client = postgres(DATABASE_URL, { max: 1, connect_timeout: 5, ssl: false, prepare: false })
  try {
    // Confirm base tenant-isolation policies exist on the tables we exercise.
    // We match by table (cast to text to avoid name/text binding quirks) rather than
    // an exact policy name, since the applied policy names may differ across schema
    // revisions while the tenant-isolation semantics stay the same.
    const policedTables = await client`
      SELECT DISTINCT tablename::text AS t FROM pg_policies
      WHERE tablename::text IN ('master_customer', 'master_soffice', 'visits', 'orders')
    `
    const coveredTables = new Set(policedTables.map((r) => r['t'] as string))
    const missing = ['master_customer', 'master_soffice', 'visits', 'orders'].filter(
      (t) => !coveredTables.has(t),
    )
    if (missing.length > 0) {
      skipReason = `RLS policies missing on: ${missing.join(', ')} — run infra/postgres/init-scripts`
      await client.end()
      return null
    }

    for (const t of ['visits', 'orders', 'master_soffice']) {
      const reg = await client`SELECT to_regclass(${'public.' + t}) AS t`
      if (!reg[0]?.['t']) {
        skipReason = `${t} table not found — database not migrated`
        await client.end()
        return null
      }
    }

    // Create (idempotently) an unprivileged NOLOGIN/NOBYPASSRLS role and grant it
    // read/write on the tables the seed + assertions touch. RLS is enforced for it.
    try {
      await client.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_TEST_ROLE}') THEN
            CREATE ROLE ${RLS_TEST_ROLE} NOLOGIN NOBYPASSRLS;
          END IF;
        END $$;
      `)
      await client.unsafe(`
        GRANT SELECT, INSERT, UPDATE, DELETE ON ${GRANT_TABLES.join(', ')}
        TO ${RLS_TEST_ROLE};
      `)
    } catch (roleErr) {
      skipReason = `cannot provision unprivileged RLS test role: ${(roleErr as Error).message}`
      await client.end()
      return null
    }

    return { client, db: drizzle(client, { schema }) }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`
    await client.end().catch(() => {})
    return null
  }
}

beforeAll(async () => {
  harness = await connect()
  if (!harness) {
    // eslint-disable-next-line no-console
    console.warn(`[tenant-isolation.integration] SKIPPED — ${skipReason}`)
  }
})

afterAll(async () => {
  if (harness) await harness.client.end()
})

describe('multi-tenant isolation — zero cross-tenant leakage (live PostgreSQL RLS)', () => {
  it('reads, writes and fail-closed default are all scoped to the active company_id', async () => {
    if (!harness) return // environment-gated skip (reason logged in beforeAll)
    const { db } = harness

    const a = tenantIds('A')
    const b = tenantIds('B')
    let assertionsRan = false

    try {
      await db.transaction(async (tx) => {
        // --- Seed two independent tenants as the privileged owner ---
        await seedTenant(tx, a)
        await seedTenant(tx, b)

        // Switch to the unprivileged role so RLS is actually enforced below.
        // SET LOCAL ROLE is transaction-scoped and reverts on rollback.
        await tx.execute(sql.raw(`SET LOCAL ROLE ${RLS_TEST_ROLE}`))

        // ---- Scenario 2: Company A context sees only Company A rows ----
        await setRLSContext(tx, { companyId: a.company, userId: a.user, userRole: 'ADMIN_PUSAT' })

        const aCustomers = (await tx.select({ id: masterCustomer.id }).from(masterCustomer)).map((r) => r.id)
        expect(aCustomers).toContain(a.customer)
        expect(aCustomers).not.toContain(b.customer)

        const aVisits = (await tx.select({ id: visits.id }).from(visits)).map((r) => r.id)
        expect(aVisits).toEqual([a.visit])

        const aOrders = (await tx.select({ id: orders.id }).from(orders)).map((r) => r.id)
        expect(aOrders).toEqual([a.order])

        const aSoffices = (await tx.select({ id: masterSoffice.id }).from(masterSoffice)).map((r) => r.id)
        expect(aSoffices).toEqual([a.soffice])

        // ---- Scenario 3: Company B context sees only Company B rows ----
        await setRLSContext(tx, { companyId: b.company, userId: b.user, userRole: 'ADMIN_PUSAT' })

        const bCustomers = (await tx.select({ id: masterCustomer.id }).from(masterCustomer)).map((r) => r.id)
        expect(bCustomers).toContain(b.customer)
        expect(bCustomers).not.toContain(a.customer)
        expect((await tx.select({ id: visits.id }).from(visits)).map((r) => r.id)).toEqual([b.visit])
        expect((await tx.select({ id: orders.id }).from(orders)).map((r) => r.id)).toEqual([b.order])

        // ---- Scenario 4: cross-tenant write attempts do NOT touch the other tenant ----
        // While in Company B context, try to rename Company A's customer by its id.
        // RLS makes A's row invisible, so the UPDATE affects zero rows (no leakage).
        const crossUpdate = await tx.execute(sql`
          UPDATE master_customer SET name = 'HIJACKED'
          WHERE id = ${a.customer}
          RETURNING id
        `)
        expect(rowsOf(crossUpdate)).toHaveLength(0)

        // Same for a cross-tenant DELETE of Company A's order from Company B context.
        const crossDelete = await tx.execute(sql`
          DELETE FROM orders WHERE id = ${a.order} RETURNING id
        `)
        expect(rowsOf(crossDelete)).toHaveLength(0)

        // A WITH CHECK violation: inserting a row stamped with the OTHER tenant's
        // company_id under Company B context must be rejected by the policy.
        const checkViolation = await expectRejected(tx, sql`
          INSERT INTO master_customer (id, company_id, soffice_id, customer_type, name)
          VALUES (${crypto.randomUUID()}, ${a.company}, ${a.soffice}, 'OUTLET', 'Smuggled Row')
        `)
        expect(checkViolation).toBe(true)

        // Confirm Company A's data is intact when viewed from Company A again.
        await setRLSContext(tx, { companyId: a.company, userId: a.user, userRole: 'ADMIN_PUSAT' })
        const survivor = await tx
          .select({ id: masterCustomer.id, name: masterCustomer.name })
          .from(masterCustomer)
          .where(eq(masterCustomer.id, a.customer))
        expect(survivor).toHaveLength(1)
        expect(survivor[0]?.name).toBe('Outlet A')
        expect((await tx.select({ id: orders.id }).from(orders)).map((r) => r.id)).toEqual([a.order])

        // ---- Scenario 5: missing/empty company_id context = fail-closed (zero rows) ----
        await clearRLSContext(tx)
        expect(await tx.select({ id: masterCustomer.id }).from(masterCustomer)).toHaveLength(0)
        expect(await tx.select({ id: visits.id }).from(visits)).toHaveLength(0)
        expect(await tx.select({ id: orders.id }).from(orders)).toHaveLength(0)
        expect(await tx.select({ id: masterSoffice.id }).from(masterSoffice)).toHaveLength(0)

        assertionsRan = true

        // Roll back everything — the test leaves no data behind.
        throw new RollbackSignal()
      })
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err
    }

    expect(assertionsRan).toBe(true)

    // Defensive: confirm the rollback discarded both seed tenants (no leaked data).
    const leftover = await harness.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, a.company))
    expect(leftover).toHaveLength(0)
  })

  it('orders policy excludes the MR role under RLS (no order rows for MR)', async () => {
    if (!harness) return
    const { db } = harness

    const a = tenantIds('MR')
    let assertionsRan = false

    try {
      await db.transaction(async (tx) => {
        await seedTenant(tx, a)
        await tx.execute(sql.raw(`SET LOCAL ROLE ${RLS_TEST_ROLE}`))

        // SALESMAN (same tenant) sees the seeded order.
        await setRLSContext(tx, { companyId: a.company, userId: a.user, userRole: 'SALESMAN' })
        expect((await tx.select({ id: orders.id }).from(orders)).map((r) => r.id)).toEqual([a.order])

        // MR is excluded by the orders policy — zero rows even within the same tenant.
        await setRLSContext(tx, { companyId: a.company, userId: a.user, userRole: 'MR' })
        expect(await tx.select({ id: orders.id }).from(orders)).toHaveLength(0)

        // MR cannot insert an order either (WITH CHECK excludes MR).
        const oid = crypto.randomUUID()
        const mrInsertBlocked = await expectRejected(tx, sql`
          INSERT INTO orders (id, company_id, soffice_id, user_id, customer_id, order_number, order_date, subtotal_amount, tax_amount, grand_total, order_status)
          VALUES (
            ${oid}, ${a.company}, ${a.soffice}, ${a.user}, ${a.customer},
            ${`ORD-MR-${oid.slice(0, 8)}`}, '2025-01-15', '100000.00', '11000.00', '111000.00', 'DRAFT'
          )
        `)
        expect(mrInsertBlocked).toBe(true)

        // But MR can still read tenant-scoped customers (not restricted by role).
        expect((await tx.select({ id: masterCustomer.id }).from(masterCustomer)).map((r) => r.id))
          .toContain(a.customer)

        assertionsRan = true
        throw new RollbackSignal()
      })
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err
    }

    expect(assertionsRan).toBe(true)
  })
})

// --- Seed helpers ---

interface TenantIds {
  suffix: string
  company: string
  soffice: string
  customer: string
  user: string
  visit: string
  order: string
}

function tenantIds(label: string): TenantIds {
  const suffix = `${label}-${Date.now().toString(36).slice(-5)}-${Math.random().toString(36).slice(2, 6)}`
  return {
    suffix,
    company: crypto.randomUUID(),
    soffice: crypto.randomUUID(),
    customer: crypto.randomUUID(),
    user: crypto.randomUUID(),
    visit: crypto.randomUUID(),
    order: crypto.randomUUID(),
  }
}

/** A point WKT helper for PostGIS geometry(point,4326) columns. */
function point(lng: number, lat: number) {
  return sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`
}

/**
 * Normalizes the result of a raw `tx.execute()` (RETURNING …) into an array of rows.
 * postgres-js returns an array-like object; this guards against driver variance.
 */
function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  const rows = (result as { rows?: unknown[] })?.rows
  return Array.isArray(rows) ? rows : []
}

type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]

/**
 * Runs a statement expected to be rejected by an RLS WITH CHECK policy, wrapped in a
 * SAVEPOINT so the failure does not abort the surrounding transaction. A failed
 * statement puts PostgreSQL into an aborted-transaction state; rolling back to the
 * savepoint clears it so subsequent assertions can continue. Returns true iff the
 * statement was rejected.
 */
async function expectRejected(tx: Tx, statement: ReturnType<typeof sql>): Promise<boolean> {
  const sp = `sp_${crypto.randomUUID().replace(/-/g, '')}`
  await tx.execute(sql.raw(`SAVEPOINT ${sp}`))
  try {
    await tx.execute(statement)
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`))
    return false
  } catch {
    await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`))
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`))
    return true
  }
}

/**
 * Seeds a fully self-contained tenant: company → soffice → user → customer → visit → order.
 *
 * Uses explicit raw SQL listing only the core, RLS-relevant columns. This keeps the
 * seed immune to non-RLS schema drift between the Drizzle model and whatever schema
 * revision the live database was initialized with — the test proves tenant isolation,
 * not column parity.
 */
async function seedTenant(
  tx: Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0],
  t: TenantIds,
): Promise<void> {
  // The A-tenant customer is named "Outlet A" to assert integrity after a blocked
  // cross-tenant update; other tenants use a generic name.
  const custName = t.suffix.startsWith('A-') ? 'Outlet A' : `Outlet ${t.suffix}`

  await tx.execute(sql`
    INSERT INTO companies (id, code, name)
    VALUES (${t.company}, ${`TEN-${t.suffix}`}, ${`Tenant ${t.suffix}`})
  `)

  await tx.execute(sql`
    INSERT INTO master_soffice (id, company_id, code, name)
    VALUES (${t.soffice}, ${t.company}, ${`SOF-${t.suffix}`}, ${`Soffice ${t.suffix}`})
  `)

  await tx.execute(sql`
    INSERT INTO app_users (id, company_id, soffice_id, email, password_hash, full_name, role_label)
    VALUES (
      ${t.user}, ${t.company}, ${t.soffice}, ${`user-${t.suffix}@test.local`},
      ${'x'.repeat(60)}, ${`User ${t.suffix}`}, 'SALESMAN'
    )
  `)

  await tx.execute(sql`
    INSERT INTO master_customer (id, company_id, soffice_id, customer_type, name)
    VALUES (${t.customer}, ${t.company}, ${t.soffice}, 'OUTLET', ${custName})
  `)

  await tx.execute(sql`
    INSERT INTO visits (id, company_id, user_id, customer_id, visit_type, visit_date, visit_in_at, visit_in_geom, sync_status)
    VALUES (
      ${t.visit}, ${t.company}, ${t.user}, ${t.customer}, 'PLANNED', '2025-01-15',
      '2025-01-15T08:00:00Z', ${point(106.8, -6.2)}, 'SYNCED'
    )
  `)

  await tx.execute(sql`
    INSERT INTO orders (id, company_id, soffice_id, user_id, customer_id, order_number, order_date, subtotal_amount, tax_amount, grand_total, order_status)
    VALUES (
      ${t.order}, ${t.company}, ${t.soffice}, ${t.user}, ${t.customer},
      ${`ORD-${t.suffix}-${t.order.slice(0, 8)}`}, '2025-01-15', '100000.00', '11000.00', '111000.00', 'DRAFT'
    )
  `)
}
