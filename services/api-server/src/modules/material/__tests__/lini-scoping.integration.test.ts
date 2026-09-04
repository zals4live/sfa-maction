import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql, eq } from 'drizzle-orm'

import * as schema from '../../../db/schema'
import { setRLSContext } from '../../../db/rls'
import { listMaterials } from '../service'

/**
 * Integration test (Phase 16) — multi-lini scoping enforced by PostgreSQL RLS.
 *
 * Unlike material/__tests__/lini-filtered-sync.test.ts (which *simulates* the RLS
 * predicate in-memory at the service layer), this test exercises the REAL
 * `tenant_isolation_master_material` compound policy against a live PostgreSQL
 * instance (see infra/postgres/init-scripts/05_rls_policies.sql). It proves the DB
 * itself — not application code — hides materials outside a field user's assigned
 * business lines.
 *
 * Field users (SALESMAN / MR) must only see materials whose `lini_id` is in their
 * active `user_lini_assignments` (plus lini-less materials). Admin roles
 * (ADMIN_PUSAT / ADMIN_CABANG) see all materials within their tenant.
 *
 * IMPORTANT — RLS and privileged roles:
 *   PostgreSQL bypasses ALL row-level security for superusers and roles with the
 *   BYPASSRLS attribute, even when a table has FORCE ROW LEVEL SECURITY. Local dev
 *   databases are often owned by such a role, so reads issued directly on the base
 *   connection would (correctly) return every row and never exercise the policy.
 *   To prove the policy the reads are run through a dedicated, unprivileged role via
 *   `SET LOCAL ROLE` inside the seeding transaction — mirroring how the API server
 *   connects as a restricted application role in production.
 *
 * The test connects using the app's DATABASE_URL and skips cleanly when no migrated
 * database is reachable (e.g. CI without the docker-compose Postgres) rather than
 * failing spuriously. All writes run inside a single transaction that is rolled back,
 * so no artifacts persist.
 *
 * Requires: `docker compose -f infra/docker/docker-compose.yml up postgres` with
 * init-scripts applied, and a matching DATABASE_URL in the environment.
 */

const { companies, masterLini, masterMaterial, appUsers, userLiniAssignments } = schema

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/maction_dev'

/** Unprivileged role used to actually exercise RLS (created on demand, no login). */
const RLS_TEST_ROLE = 'maction_rls_test_role'

// Sentinel error thrown to force a transaction rollback after assertions run.
class RollbackSignal extends Error {}

interface Harness {
  client: postgres.Sql
  db: ReturnType<typeof drizzle>
}

let harness: Harness | null = null
let skipReason: string | null = null

/**
 * Establishes a live connection, confirms the schema + RLS policy are present, and
 * ensures an unprivileged role exists to genuinely exercise RLS. Returns null (and
 * records skipReason) when the environment can't support the test.
 */
async function connect(): Promise<Harness | null> {
  const client = postgres(DATABASE_URL, { max: 1, connect_timeout: 5, ssl: false, prepare: false })
  try {
    const policy = await client`
      SELECT 1 FROM pg_policies
      WHERE tablename = 'master_material' AND policyname = 'tenant_isolation_master_material'
    `
    if (policy.length === 0) {
      skipReason = 'master_material RLS policy not found — run infra/postgres/init-scripts'
      await client.end()
      return null
    }

    const ula = await client`SELECT to_regclass('public.user_lini_assignments') AS t`
    if (!ula[0]?.['t']) {
      skipReason = 'user_lini_assignments table not found — database not migrated'
      await client.end()
      return null
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
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          companies, master_lini, master_material, app_users, user_lini_assignments
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
    console.warn(`[lini-scoping.integration] SKIPPED — ${skipReason}`)
  }
})

afterAll(async () => {
  if (harness) await harness.client.end()
})

describe('material RLS — multi-lini scoping (live PostgreSQL)', () => {
  it('field users see only materials from their assigned lini; admins see all', async () => {
    if (!harness) return // environment-gated skip (reason logged in beforeAll)
    const { db } = harness

    const ids = seedIds()
    let assertionsRan = false

    try {
      await db.transaction(async (tx) => {
        // --- Seed a self-contained tenant with two business lines (as owner) ---
        await tx.insert(companies).values({
          id: ids.company,
          code: `TST-${ids.suffix}`,
          name: 'RLS Lini Scoping Test Co',
        })

        await tx.insert(masterLini).values([
          { id: ids.liniEthical, companyId: ids.company, code: `ETH-${ids.suffix}`, name: 'Farma Ethical' },
          { id: ids.liniOtc, companyId: ids.company, code: `OTC-${ids.suffix}`, name: 'OTC' },
        ])

        // Materials: 2 in ETHICAL, 1 in OTC, 1 with no lini (visible to all field users).
        await tx.insert(masterMaterial).values([
          material(ids.matEth1, ids.company, ids.liniEthical, 'Ethical Drug A'),
          material(ids.matEth2, ids.company, ids.liniEthical, 'Ethical Drug B'),
          material(ids.matOtc1, ids.company, ids.liniOtc, 'OTC Vitamin'),
          material(ids.matGlobal, ids.company, null, 'Unscoped Item'),
        ])

        // A SALESMAN assigned to ETHICAL only, and an ADMIN_PUSAT for the same tenant.
        await tx.insert(appUsers).values([
          user(ids.salesman, ids.company, 'salesman', 'SALESMAN'),
          user(ids.admin, ids.company, 'admin', 'ADMIN_PUSAT'),
        ])

        await tx.insert(userLiniAssignments).values({
          id: ids.assignment,
          companyId: ids.company,
          userId: ids.salesman,
          liniId: ids.liniEthical,
          isActive: true,
        })

        // Switch to the unprivileged role so RLS is actually enforced for all reads
        // below. SET LOCAL is transaction-scoped and reverts on rollback.
        await tx.execute(sql.raw(`SET LOCAL ROLE ${RLS_TEST_ROLE}`))

        // --- SALESMAN assigned to ETHICAL only ---
        await setRLSContext(tx, { companyId: ids.company, userId: ids.salesman, userRole: 'SALESMAN' })

        const salesmanIds = (await listMaterials(tx as never, { limit: 100 })).data
          .map((m) => m.id)
          .sort()

        // Sees both ETHICAL materials + the unscoped one; never the OTC material.
        expect(salesmanIds).toEqual([ids.matEth1, ids.matEth2, ids.matGlobal].sort())
        expect(salesmanIds).not.toContain(ids.matOtc1)

        // --- Same user acting as MR (also a field role) — identical lini gate ---
        await setRLSContext(tx, { companyId: ids.company, userId: ids.salesman, userRole: 'MR' })
        const mrIds = (await listMaterials(tx as never, { limit: 100 })).data.map((m) => m.id).sort()
        expect(mrIds).toEqual([ids.matEth1, ids.matEth2, ids.matGlobal].sort())
        expect(mrIds).not.toContain(ids.matOtc1)

        // --- ADMIN_PUSAT sees every material in the tenant, regardless of lini ---
        await setRLSContext(tx, { companyId: ids.company, userId: ids.admin, userRole: 'ADMIN_PUSAT' })
        const adminIds = (await listMaterials(tx as never, { limit: 100 })).data.map((m) => m.id).sort()
        expect(adminIds).toEqual([ids.matEth1, ids.matEth2, ids.matOtc1, ids.matGlobal].sort())

        assertionsRan = true

        // Roll back everything — the test leaves no data behind.
        throw new RollbackSignal()
      })
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err
    }

    expect(assertionsRan).toBe(true)

    // Defensive: confirm the rollback discarded the seed (no leaked test tenant).
    const leftover = await harness.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, ids.company))
    expect(leftover).toHaveLength(0)
  })
})

// --- Seed helpers ---

function seedIds() {
  const suffix = Date.now().toString(36).slice(-6)
  return {
    suffix,
    company: crypto.randomUUID(),
    liniEthical: crypto.randomUUID(),
    liniOtc: crypto.randomUUID(),
    matEth1: crypto.randomUUID(),
    matEth2: crypto.randomUUID(),
    matOtc1: crypto.randomUUID(),
    matGlobal: crypto.randomUUID(),
    salesman: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    assignment: crypto.randomUUID(),
  }
}

function material(id: string, companyId: string, liniId: string | null, name: string) {
  return {
    id,
    companyId,
    erpMaterialCode: `ERP-${id.slice(0, 8)}`,
    name,
    baseUom: 'PCS',
    salesUom: 'BOX',
    liniId,
    uomConversionRules: { BOX: 10 },
    isActive: true,
    isDeleted: false,
  }
}

function user(
  id: string,
  companyId: string,
  handle: string,
  role: 'SALESMAN' | 'MR' | 'ADMIN_PUSAT' | 'ADMIN_CABANG' | 'SUPER_ADMIN',
) {
  return {
    id,
    companyId,
    email: `${handle}-${id.slice(0, 8)}@test.local`,
    passwordHash: 'x'.repeat(60),
    fullName: `${handle} tester`,
    roleLabel: role,
    isActive: true,
  }
}
